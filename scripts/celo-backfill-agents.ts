/**
 * Celo ERC-8004 IdentityRegistry → wallets table backfill.
 *
 * One-shot materialize of every registered Celo agent into AgentKarma's
 * `wallets` table so the `/api/leaderboard?chain=celo` surface and any
 * future Celo-chain explore filter have real rows to render. Tier 3
 * metadata-only — each row gets a metadata-quality score (0–100) derived
 * from the agent's on-chain registration JSON via
 * `src/scoring/celo-metadata.ts` and one synthetic `signal_events` row
 * (tier=3, kind='metadata_quality', tx_ref=null).
 *
 * Idempotency:
 *  - wallets:       upsert onConflict (chain, address); column set is narrow
 *                   (claim/Self/autonomy fields are NEVER touched) so re-runs
 *                   do not clobber AK's own row at agentId 9058.
 *  - signal_events: upsert onConflict (chain, agent_wallet, kind, tx_ref).
 *                   tx_ref is NULL for synthetic backfill events; per
 *                   Postgres NULL semantics the conflict target doesn't dedup
 *                   NULLs — we manually pre-check + skip in --rerun mode.
 *                   First-run is safe regardless.
 *
 * Discovery:
 *   ERC-721 here does not expose totalSupply(). We probe sequentially from
 *   --from upward, stopping after N consecutive missing tokens (5 by default).
 *
 * Usage:
 *   bun run scripts/celo-backfill-agents.ts                 # full run, write to DB
 *   bun run scripts/celo-backfill-agents.ts --simulate      # read+score, no writes
 *   bun run scripts/celo-backfill-agents.ts --from 1 --to 50
 *   bun run scripts/celo-backfill-agents.ts --concurrency 4 --stop-after 10
 */

import { readAgent } from '../src/integrations/erc8004-celo';
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

const FROM = Math.max(1, Number(argVal('from', '1')));
const TO_RAW = argVal('to');
const TO = TO_RAW ? Number(TO_RAW) : null;
const LIMIT_RAW = argVal('limit');
const LIMIT = LIMIT_RAW ? Number(LIMIT_RAW) : Infinity;
const CONCURRENCY = Math.max(1, Math.min(8, Number(argVal('concurrency', '4'))));
const SIMULATE = argFlag('simulate');
const STOP_AFTER_MISSING = Math.max(1, Number(argVal('stop-after', '5')));

if (!Number.isFinite(FROM) || (TO != null && !Number.isFinite(TO))) {
  console.error('usage: --from <int> [--to <int>] [--limit <int>] [--simulate] [--concurrency <int>] [--stop-after <int>]');
  process.exit(1);
}

console.log(`[backfill] mode:        ${SIMULATE ? 'SIMULATE (no writes)' : 'WRITE'}`);
console.log(`[backfill] from:        ${FROM}`);
console.log(`[backfill] to:          ${TO ?? '∞ (stop on ' + STOP_AFTER_MISSING + ' consecutive misses)'}`);
console.log(`[backfill] limit:       ${Number.isFinite(LIMIT) ? LIMIT : 'unbounded'}`);
console.log(`[backfill] concurrency: ${CONCURRENCY}`);
console.log('');

// AK's own agentId — exclude metadata-quality writes against itself so the
// AK row's display fields stay solely whatever the AK owner has set (currently
// nothing; if the owner ever fills display_name/website we must not overwrite).
const AK_AGENT_ID = 9058;

// ─── Types ────────────────────────────────────────────────────────────────────

interface Outcome {
  agentId: number;
  status: 'written' | 'simulated' | 'missing' | 'error' | 'skipped_ak';
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

// Hard ceiling per agent. The integration's fetchRegistration has an 8s
// AbortSignal but a slow JSON parse / on-demand RPC + chained reads can
// still tie up the worker for tens of seconds. We don't want a single bad
// host to block one of CONCURRENCY worker slots forever.
const PER_AGENT_TIMEOUT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); },
           (e) => { clearTimeout(t); reject(e); });
  });
}

async function processAgent(id: number): Promise<Outcome> {
  if (id === AK_AGENT_ID) {
    return { agentId: id, status: 'skipped_ak', registered: true, hasRegistration: true };
  }

  let agent: Awaited<ReturnType<typeof readAgent>> = null;
  try {
    agent = await withTimeout(readAgent(BigInt(id)), PER_AGENT_TIMEOUT_MS, `readAgent(${id})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Contract reverts on ownerOf / tokenURI past the registry tip are how
    // ERC-721 reports "no such token" on chains that don't return the canonical
    // ERC721NonexistentToken selector. Treat any revert as 'missing' so the
    // stop-after-N-consecutive-misses loop terminates instead of looping
    // forever past the tip. Network / RPC errors look different — they show
    // up as "fetch failed" / "ECONNREFUSED" / timeouts — and stay 'error'.
    const isRevert = msg.includes('reverted') || msg.includes('revert');
    if (isRevert) {
      return { agentId: id, status: 'missing', registered: false, hasRegistration: false };
    }
    return { agentId: id, status: 'error', registered: false, hasRegistration: false, error: msg };
  }
  if (!agent) {
    return { agentId: id, status: 'missing', registered: false, hasRegistration: false };
  }

  const quality = scoreMetadataQuality(agent);
  const owner = agent.owner.toLowerCase();
  const hasReg = !!agent.registration;
  const trustTier = getTrustTier(quality.score);
  const name = agent.registration?.name ?? null;

  // Pick a website from the registration: first http(s) service endpoint.
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

  // Wallet upsert — narrow column set. Do NOT include claim/Self/autonomy
  // fields. The upsert merges by (chain, address); columns we don't list are
  // preserved on conflict.
  const nowIso = new Date().toISOString();
  const walletRow: Record<string, unknown> = {
    chain: 'celo',
    address: owner,
    celo_agent_id: id,
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

  // Signal event upsert. `insertSignalEvent` helper in db/client.ts doesn't
  // thread chain through (it pre-dates 0004_multichain), so we write raw to
  // include chain='celo'. tx_ref is null because this is a synthetic
  // metadata-derived signal, not an on-chain event. The unique index is
  // (chain, agent_wallet, kind, tx_ref) — Postgres treats NULLs as distinct
  // by default, so re-runs would insert duplicate NULL rows. We use
  // `ignoreDuplicates: false` + `overwrite` semantics by manually checking
  // first and skipping if a row already exists.
  const { data: existingSignal } = await supabase
    .from('signal_events')
    .select('id')
    .eq('chain', 'celo')
    .eq('agent_wallet', owner)
    .eq('kind', 'metadata_quality')
    .is('tx_ref', null)
    .limit(1);

  if (!existingSignal || existingSignal.length === 0) {
    const { error: signalErr } = await supabase
      .from('signal_events')
      .insert({
        chain: 'celo',
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
//
// `CONCURRENCY` workers each pull the next id from a shared cursor — no
// barrier between batches. One slow worker (stuck on a slow registration
// JSON fetch) never blocks the other CONCURRENCY-1 workers. Stop condition
// reads a shared `consecutiveMisses` counter that workers atomically bump.

const startedAt = Date.now();
let lastLogged = 0;

function logProgress(id: number, o: Outcome) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
  const tag = o.status === 'written' ? 'WRITE'
            : o.status === 'simulated' ? 'SIM'
            : o.status === 'missing' ? '----'
            : o.status === 'skipped_ak' ? 'SKIP'
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

/** Atomically reserve the next id; returns null when there are no more. */
function nextId(): number | null {
  if (consecutiveMisses >= STOP_AFTER_MISSING) return null;
  if (TO != null && cursor > TO) return null;
  if (cursor >= FROM + LIMIT) return null;
  const id = cursor;
  cursor++;
  return id;
}

function onResult(o: Outcome) {
  outcomes.push(o);
  outcomesCount++;
  // consecutiveMisses is order-sensitive but workers complete out-of-order;
  // we approximate by treating any non-missing result as a reset and any
  // missing as +1. Over the long tail this is exactly right because the tip
  // is followed by a contiguous block of unregistered ids.
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
