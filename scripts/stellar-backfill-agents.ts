/**
 * Stellar (trionlabs/stellar-8004) IdentityRegistry → wallets table backfill.
 *
 * One-shot materialize of every registered Stellar agent into AgentKarma's
 * `wallets` table so the `/api/leaderboard?chain=stellar` surface, `/explore`,
 * and `/agent/G...` pages have real rows to render. Tier 3 metadata-only —
 * each row gets a metadata-quality score (0–100) derived from the agent's
 * on-chain registration JSON via `src/scoring/celo-metadata.ts`
 * (chain-agnostic `agentkarma_metadata v0.1` scheme; reused, not duplicated).
 *
 * Idempotency:
 *  - wallets:       upsert onConflict (chain, address); column set is narrow
 *                   (claim/Self/autonomy fields are NEVER touched) so re-runs
 *                   do not clobber any user-curated display fields.
 *  - signal_events: same (chain, agent_wallet, kind, tx_ref) unique index as
 *                   Celo. tx_ref is NULL for synthetic backfill events — manual
 *                   pre-check before insert to avoid duplicate NULL rows on
 *                   reruns.
 *
 * Discovery:
 *   IdentityRegistry exposes `total_agents()` → u64 = (highest agentId + 1).
 *   Walk 0..total-1 — IDs are sequential, no gaps in the trionlabs registry.
 *   Optional `--stop-after` fallback to the N-consecutive-missing pattern
 *   keeps the loop safe if `total_agents` ever undercounts.
 *
 * StrKey casing: G-addresses are uppercase by convention; the `STELLAR_ADDRESS_RE`
 * in chain-adapters/stellar.ts accepts uppercase ONLY. We persist them as the
 * contract returns them (uppercase).
 *
 * Usage:
 *   bun run scripts/stellar-backfill-agents.ts                 # full run, write to DB
 *   bun run scripts/stellar-backfill-agents.ts --simulate      # read+score, no writes
 *   bun run scripts/stellar-backfill-agents.ts --from 0 --to 50
 *   bun run scripts/stellar-backfill-agents.ts --concurrency 2 --stop-after 5
 *
 * NOTE: Stellar RPC throttling is generally less aggressive than Celo's Forno,
 * but `simulateTransaction` is a heavier round-trip per agent (3 calls per
 * read). Default concurrency is intentionally lower (2).
 */

import {
  readStellarAgent,
  getStellarTotalAgents,
  getStellarRpc,
} from '../src/integrations/erc8004-stellar';
import { withRateLimitRetry } from '../src/indexer/stellar-registry';
import { scoreMetadataQuality } from '../src/scoring/celo-metadata';
import { getTrustTier } from '../src/scoring/index';
import { supabase } from '../src/db/client';

// ─── CLI parsing ──────────────────────────────────────────────────────────────

function argVal(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}
function argFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const FROM = Math.max(0, Number(argVal('from', '0'))); // Stellar IDs start at 0
const TO_RAW = argVal('to');
const TO = TO_RAW ? Number(TO_RAW) : null;
const LIMIT_RAW = argVal('limit');
const LIMIT = LIMIT_RAW ? Number(LIMIT_RAW) : Infinity;
const CONCURRENCY = Math.max(1, Math.min(8, Number(argVal('concurrency', '2'))));
const SIMULATE = argFlag('simulate');
const STOP_AFTER_MISSING = Math.max(1, Number(argVal('stop-after', '5')));

if (!Number.isFinite(FROM) || (TO != null && !Number.isFinite(TO))) {
  console.error('usage: --from <int> [--to <int>] [--limit <int>] [--simulate] [--concurrency <int>] [--stop-after <int>]');
  process.exit(1);
}

const server = getStellarRpc();

// Resolve the tip from total_agents (sequential ids 0..total-1). The user can
// still override via --to to truncate. --to also wins when explicitly set.
let tip: number;
try {
  const total = await getStellarTotalAgents(server);
  tip = total - 1;
} catch (err) {
  console.error(`[backfill] failed to read total_agents — falling back to consecutive-miss stop. err=${err instanceof Error ? err.message : String(err)}`);
  tip = -1;
}

const EFFECTIVE_TO = TO ?? (tip >= 0 ? tip : null);

console.log(`[backfill] mode:        ${SIMULATE ? 'SIMULATE (no writes)' : 'WRITE'}`);
console.log(`[backfill] from:        ${FROM}`);
console.log(`[backfill] total_agents:${tip >= 0 ? tip + 1 : 'unknown (rpc error)'}`);
console.log(`[backfill] to:          ${EFFECTIVE_TO ?? '∞ (stop on ' + STOP_AFTER_MISSING + ' consecutive misses)'}`);
console.log(`[backfill] limit:       ${Number.isFinite(LIMIT) ? LIMIT : 'unbounded'}`);
console.log(`[backfill] concurrency: ${CONCURRENCY}`);
console.log('');

// ─── Types ────────────────────────────────────────────────────────────────────

interface Outcome {
  agentId: number;
  status: 'written' | 'simulated' | 'missing' | 'error';
  registered: boolean;
  hasRegistration: boolean;
  score?: number;
  owner?: string;
  name?: string;
  error?: string;
}

const outcomes: Outcome[] = [];
const scoreBuckets = new Array(11).fill(0); // 0-9, 10-19, …, 100
let consecutiveMisses = 0;
let processedRegistered = 0;
let walletsWritten = 0;
let signalsWritten = 0;

// ─── Per-id worker ────────────────────────────────────────────────────────────

const PER_AGENT_TIMEOUT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); },
           (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * The public Soroban RPC throttles hard: a 3-worker run 429s after ~15 agents,
 * and every subsequent id fails instantly. `readStellarAgent` is 3 simulate
 * round-trips, so the effective request rate is ~3x the agent rate. The retry
 * policy is shared with the registry-mirror scanner (`withRateLimitRetry`):
 * back off on 429 only, never on a contract revert.
 */
async function readAgentWithBackoff(id: number) {
  return withRateLimitRetry(
    () => withTimeout(readStellarAgent(server, id), PER_AGENT_TIMEOUT_MS, `readStellarAgent(${id})`),
  );
}

async function processAgent(id: number): Promise<Outcome> {
  let agent: Awaited<ReturnType<typeof readStellarAgent>> = null;
  try {
    agent = await readAgentWithBackoff(id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Soroban returns HostError Contract#2 / "AgentNotFound" on unregistered
    // agentIds. agent_exists pre-check already filters these, so a thrown
    // revert here implies a real RPC issue OR a race past the tip — treat as
    // 'missing' so the stop-after-N-consecutive-misses loop terminates.
    const isRevert = msg.includes('Error(Contract') || msg.includes('AgentNotFound') || msg.includes('not found');
    if (isRevert) {
      return { agentId: id, status: 'missing', registered: false, hasRegistration: false };
    }
    return { agentId: id, status: 'error', registered: false, hasRegistration: false, error: msg };
  }
  if (!agent) {
    return { agentId: id, status: 'missing', registered: false, hasRegistration: false };
  }

  const quality = scoreMetadataQuality(agent);
  // StrKey G-addresses are uppercase by convention; STELLAR_ADDRESS_RE accepts
  // uppercase only — persist as returned.
  const owner = agent.owner;
  const hasReg = !!agent.registration;
  const trustTier = getTrustTier(quality.score);
  const name = agent.registration?.name ?? null;

  let website: string | null = null;
  const services = Array.isArray(agent.registration?.services) ? agent.registration!.services : [];
  for (const s of services) {
    if (typeof s?.endpoint === 'string' && /^https?:\/\//.test(s.endpoint)) {
      website = s.endpoint;
      break;
    }
  }

  if (SIMULATE) {
    return {
      agentId: id,
      status: 'simulated',
      registered: true,
      hasRegistration: hasReg,
      score: quality.score,
      owner,
      name: name ?? undefined,
    };
  }

  const nowIso = new Date().toISOString();
  const walletRow: Record<string, unknown> = {
    chain: 'stellar',
    address: owner,
    stellar_agent_id: id,
    score: quality.score,
    provider_score: quality.score,
    trust_tier: trustTier,
    confidence_badge: 'declared',
    last_seen: nowIso,
    updated_at: nowIso,
  };
  if (name) walletRow.display_name = name;
  if (agent.registration?.image) walletRow.image_url = agent.registration.image;
  if (agent.registration?.description) walletRow.description = agent.registration.description;
  if (website) walletRow.website = website;

  const { error: walletErr } = await supabase
    .from('wallets')
    .upsert(walletRow, { onConflict: 'chain,address' });
  if (walletErr) {
    return {
      agentId: id,
      status: 'error',
      registered: true,
      hasRegistration: hasReg,
      score: quality.score,
      owner,
      error: `wallet upsert: ${walletErr.message}`,
    };
  }

  // signal_events: dedup on (chain, agent_wallet, kind, tx_ref). tx_ref is NULL
  // (synthetic), so Postgres treats it as distinct on the unique index — manual
  // pre-check skips on reruns.
  const { data: existingSignal } = await supabase
    .from('signal_events')
    .select('id')
    .eq('chain', 'stellar')
    .eq('agent_wallet', owner)
    .eq('kind', 'metadata_quality')
    .is('tx_ref', null)
    .limit(1);

  if (!existingSignal || existingSignal.length === 0) {
    const { error: signalErr } = await supabase
      .from('signal_events')
      .insert({
        chain: 'stellar',
        agent_wallet: owner,
        tier: 3,
        kind: 'metadata_quality',
        face: 'provider',
        weight: 1.0,
        value: quality.score / 100,
        payload: {
          agentId: id,
          scheme: 'agentkarma_metadata_v0.1',
          breakdown: quality.breakdown,
          notes: quality.notes,
        },
        tx_ref: null,
      });
    if (signalErr) {
      return {
        agentId: id,
        status: 'error',
        registered: true,
        hasRegistration: hasReg,
        score: quality.score,
        owner,
        error: `signal insert: ${signalErr.message}`,
      };
    }
    signalsWritten++;
  }

  walletsWritten++;
  return {
    agentId: id,
    status: 'written',
    registered: true,
    hasRegistration: hasReg,
    score: quality.score,
    owner,
    name: name ?? undefined,
  };
}

// ─── Worker-pool driver ───────────────────────────────────────────────────────

const startedAt = Date.now();
let lastLogged = 0;

function logProgress(id: number, o: Outcome) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
  const tag = o.status === 'written' ? 'WRITE'
            : o.status === 'simulated' ? 'SIM'
            : o.status === 'missing' ? '----'
            : 'ERR ';
  const score = o.score != null ? `score ${String(o.score).padStart(3)}` : '         ';
  const nameStr = o.name ? ` ${o.name.slice(0, 30)}` : '';
  const ownerStr = o.owner ? ` owner ${o.owner.slice(0, 8)}…${o.owner.slice(-4)}` : '';
  const detail = o.error ? ` err=${o.error.slice(0, 60)}` : '';
  console.log(
    `[${elapsed.padStart(5)}s][${String(processedRegistered).padStart(5)}/${String(id).padStart(5)}] ${tag}  agent ${String(id).padStart(5)} ${score}${ownerStr}${nameStr}${detail}`,
  );
}

let cursor = FROM;
let outcomesCount = 0;

function nextId(): number | null {
  if (consecutiveMisses >= STOP_AFTER_MISSING) return null;
  if (EFFECTIVE_TO != null && cursor > EFFECTIVE_TO) return null;
  if (cursor >= FROM + LIMIT) return null;
  const id = cursor;
  cursor++;
  return id;
}

function onResult(o: Outcome) {
  outcomes.push(o);
  outcomesCount++;
  if (o.status === 'missing') {
    consecutiveMisses++;
  } else {
    consecutiveMisses = 0;
    processedRegistered++;
    if (o.score != null) {
      const bucket = Math.min(10, Math.floor(o.score / 10));
      scoreBuckets[bucket]++;
    }
  }

  const shouldLog = outcomesCount <= 50
    ? true
    : outcomesCount - lastLogged >= 25
      || o.status === 'error'
      || (o.status === 'written' && (o.score ?? 0) >= 70);
  if (shouldLog) {
    logProgress(o.agentId, o);
    lastLogged = outcomesCount;
  }
}

async function worker() {
  while (true) {
    const id = nextId();
    if (id == null) return;
    const o = await processAgent(id);
    onResult(o);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('');
console.log('─── summary ──────────────────────────────────────────────');
console.log(`elapsed:              ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
console.log(`agentIds attempted:   ${outcomes.length}`);
const registered = outcomes.filter((o) => o.registered).length;
const withReg = outcomes.filter((o) => o.hasRegistration).length;
const errors = outcomes.filter((o) => o.status === 'error').length;
console.log(`registered:           ${registered}`);
console.log(`with registration:    ${withReg}`);
console.log(`wallets ${SIMULATE ? 'would write' : 'written  '}:  ${SIMULATE ? outcomes.filter((o) => o.status === 'simulated').length : walletsWritten}`);
console.log(`signal_events written:${signalsWritten}`);
console.log(`errors:               ${errors}`);
const maxAttempted = outcomes.reduce((m, o) => Math.max(m, o.agentId), 0);
console.log(`stopped at:           agentId ${maxAttempted} (consecutive misses: ${consecutiveMisses})`);
console.log('');
console.log('score distribution (registered agents only):');
const bucketLabels = ['0-9', '10-19', '20-29', '30-39', '40-49', '50-59', '60-69', '70-79', '80-89', '90-99', '100'];
const maxBucket = Math.max(...scoreBuckets, 1);
for (let i = 0; i < scoreBuckets.length; i++) {
  const bar = '█'.repeat(Math.round((scoreBuckets[i] / maxBucket) * 30));
  console.log(`  ${bucketLabels[i].padEnd(6)} ${String(scoreBuckets[i]).padStart(5)}  ${bar}`);
}

if (errors > 0) {
  console.log('');
  console.log(`first ${Math.min(5, errors)} errors:`);
  for (const o of outcomes.filter((o) => o.status === 'error').slice(0, 5)) {
    console.log(`  agent ${o.agentId}: ${o.error}`);
  }
}

console.log('');
process.exit(0);
