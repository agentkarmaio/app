/**
 * Bounded metadata-quality attestation run against the stellar-8004 Reputation
 * Registry (mainnet). The Stellar twin of `scripts/celo-batch-feedback.ts`, and
 * the thing that turns `publish-stellar-feedback.ts` from a one-shot manual
 * write into a cadence.
 *
 *   bun run scripts/stellar-batch-feedback.ts                 # simulate 3
 *   bun run scripts/stellar-batch-feedback.ts --count 5       # simulate 5
 *   bun run scripts/stellar-batch-feedback.ts --execute       # WRITE 3 to mainnet
 *
 * Flags: --count <n>  writes per run (default 3)
 *        --min <n>    metadata-quality floor (default 70)
 *        --jitter <s> seconds between writes (default 25, execute only)
 *        --execute    actually send; omitted = simulate, the default
 *
 * Why this shape:
 *
 *  - The eligible Stellar population is TENS of agents, not thousands. So the
 *    run sweeps every eligible agent for an existing AK rating FIRST, prints
 *    the coverage (eligible / rated / remaining), and only then picks its
 *    bounded slice from what is left. Slots are never wasted on agents already
 *    rated, and the number a partner cares about — "how much of the registry
 *    has AgentKarma actually assessed" — is on every run's log.
 *
 *  - The pool exhausts. After a handful of runs there is nothing left to rate
 *    and the job becomes a quiet green no-op until someone registers a new
 *    agent. That IS the steady state, not a failure.
 *
 *  - Every gate is a SKIP, never a substitute score. See
 *    `src/integrations/erc8004-stellar-attest.ts` — an attestation is permanent
 *    and public, so refusing to publish beats publishing something misleading.
 *
 *  - Nothing is ever resent. The Soroban RPC drops a meaningful share of send
 *    responses while the transaction still lands, so the write path resolves
 *    each attempt against the account sequence (confirmed / failed / expired /
 *    indeterminate) and this script simply reports what happened. A write that
 *    landed unseen is caught by the NEXT run's dedupe sweep.
 *
 * Fee account: AK's own Horizon account is read once, up front, and the run
 * refuses to start below the XLM floor — a cadence that cannot pay fees fails
 * on the invisible side. No TARGET account is fetched from Horizon, so the
 * absent-account alert shape (a never-funded account 404ing) cannot arise.
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (target selection),
 *      STELLAR_RPC_URL / STELLAR_HORIZON_URL (optional overrides),
 *      STELLAR_PRIVATE_KEY or .keys/agentkarma-stellar.json — REQUIRED ONLY
 *      with --execute. A simulate run never touches the secret.
 */

import { rpc } from '@stellar/stellar-sdk';
import { readStellarAgent, readStellarSummary } from '../src/integrations/erc8004-stellar';
import { resolveStellarRpcUrl } from '../src/integrations/stellar-config';
import {
  loadStellarKeypair,
  publishStellarFeedback,
  feedbackHashFromJson,
  isFeeCeilingError,
} from '../src/integrations/erc8004-stellar-publish';
import {
  ATTEST_BATCH_SIZE,
  ATTEST_MIN_SCORE,
  buildStellarAssessment,
  classifyTarget,
  feeCeilingStroops,
  readStellarFeeAccount,
  MAX_FEE_XLM,
  MIN_XLM_BALANCE,
  type AttestDecision,
} from '../src/integrations/erc8004-stellar-attest';
import { scoreMetadataQuality } from '../src/scoring/celo-metadata';
import { AK_STELLAR } from '../src/config/ak-validator';
import { supabase } from '../src/db/client';
import { requireEnv } from '../src/lib/require-env';

const SCHEME_TAG1 = AK_STELLAR.scheme.tag1;
const SCHEME_TAG2 = AK_STELLAR.scheme.tag2;

function argVal(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const execute = process.argv.includes('--execute');
const count = Number(argVal('count', String(ATTEST_BATCH_SIZE)));
const minScore = Number(argVal('min', String(ATTEST_MIN_SCORE)));
const maxFeeXlm = Number(argVal('max-fee', String(MAX_FEE_XLM)));
const jitterSec = Number(argVal('jitter', '25'));

if (!Number.isInteger(count) || count < 1 || !Number.isFinite(minScore)) {
  console.error('usage: --count <int> [--min <int>] [--jitter <sec>] [--execute]');
  process.exit(1);
}

// Fail at line 1 when the DB secrets are missing rather than selecting zero
// targets and reporting a green "nothing to publish" (the empty-secret shape).
requireEnv(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const server = new rpc.Server(resolveStellarRpcUrl(), { allowHttp: false });
// Execute needs the signing key; simulate deliberately does not, so an unarmed
// scheduled run still exercises selection → gates → dedupe → simulate.
const keypair = execute ? loadStellarKeypair() : undefined;
const akAccount = keypair?.publicKey() ?? AK_STELLAR.account;

// AK's attestations are openly attributed to ONE disclosed account (/validator,
// AK_STELLAR.account). A different signer would publish under AK's scheme from
// an undisclosed address — the exact rater-diversity fake AK's own Sybil signal
// is supposed to catch — and would also scope the dedupe sweep to the wrong
// client, re-rating agents AK has already rated.
if (execute && akAccount !== AK_STELLAR.account) {
  console.error(
    `[attest] FAILED: signer ${akAccount} is not AK's disclosed Stellar account ` +
      `(${AK_STELLAR.account}). Refusing to publish under the disclosed scheme from an undisclosed key.`,
  );
  process.exit(1);
}

console.log(`[attest] mode:     ${execute ? 'EXECUTE (mainnet writes)' : 'simulate'}`);
console.log(`[attest] account:  ${akAccount}`);
console.log(`[attest] scheme:   ${SCHEME_TAG1} ${SCHEME_TAG2}`);
console.log(`[attest] budget:   ${count} write(s), min score ${minScore}, max fee ${maxFeeXlm} XLM/write`);
console.log('');

// ─── 1. Fee-account preflight ───────────────────────────────────────────────

const fee = await readStellarFeeAccount(akAccount, { minXlm: MIN_XLM_BALANCE });
if (fee.state === 'absent') {
  console.error(`[attest] FAILED: ${akAccount} does not exist on this network — fund it before scheduling.`);
  process.exit(1);
}
console.log(`[attest] balance:  ${fee.xlm} XLM (floor ${MIN_XLM_BALANCE}) · sequence ${fee.sequence}`);
if (fee.state === 'low') {
  console.error(
    `[attest] FAILED: balance ${fee.xlm} XLM is below the ${MIN_XLM_BALANCE} XLM floor — ` +
      `refusing to start a cadence that cannot pay Soroban fees.`,
  );
  process.exit(1);
}
// A healthy balance does not mean the next write is affordable: the Soroban
// resource fee is a property of network state and moved ~360x between
// 2026-08-04 (0.15 XLM) and 2026-09-10 (53.89 XLM). The real gate is the
// SIMULATED fee, enforced per transaction just before signing.
const ceiling = feeCeilingStroops(fee.xlm, maxFeeXlm);
console.log(`[attest] fee gate: refuse any write above ${(ceiling / 1e7).toFixed(4)} XLM`);

// ─── 2. Eligible population from the registry mirror ────────────────────────

const { data: mirror, error: mirrorErr } = await supabase
  .from('erc8004_agents')
  .select('agent_id, metadata_score')
  .eq('chain', 'stellar')
  .gte('metadata_score', minScore)
  .order('agent_id', { ascending: true });
if (mirrorErr) throw new Error(`registry mirror read failed: ${mirrorErr.message}`);

const eligible = (mirror ?? [])
  .map((r) => Number(r.agent_id))
  .filter((id) => id !== AK_STELLAR.agentId);

// ─── 3. Dedupe sweep — who has AK already rated? ────────────────────────────

// tag2 is left EMPTY on purpose: it matches any scheme VERSION, so an agent
// rated under v0.1 counts as rated and is never re-rated under v0.2. The
// version on chain stays honest about which rubric actually ran.
async function alreadyRated(agentId: number): Promise<boolean> {
  const summary = await readStellarSummary(server, agentId, [akAccount], SCHEME_TAG1, '');
  return summary.count > 0;
}

const rated: number[] = [];
const unrated: number[] = [];
for (const id of eligible) {
  try {
    (await alreadyRated(id)) ? rated.push(id) : unrated.push(id);
  } catch (err) {
    // A sweep read that fails is NOT evidence of "unrated" — excluding the
    // agent is the safe direction: a missed rating costs a day, a duplicate
    // attestation is permanent.
    console.log(`  agent ${String(id).padStart(4)}: dedupe read failed (${(err as Error).message.slice(0, 60)}) — excluded`);
  }
}

console.log(
  `[attest] coverage: ${eligible.length} eligible (score ≥ ${minScore}) · ` +
    `${rated.length} already rated by AK · ${unrated.length} remaining`,
);
if (rated.length > 0) console.log(`[attest] rated:    ${rated.join(', ')}`);

const targets = shuffle([...unrated]).slice(0, count);
if (targets.length === 0) {
  console.log('');
  console.log(
    eligible.length === 0
      ? `[attest] nothing to publish — no registered agent scores ${minScore} or above yet.`
      : '[attest] nothing left to publish — every eligible agent already carries an AK rating.',
  );
  // An exhausted pool is the steady state of a finite registry, not a failure.
  process.exit(0);
}
console.log(`[attest] targets:  ${targets.join(', ')}`);
console.log('');

// ─── 4. Publish ─────────────────────────────────────────────────────────────

interface Outcome {
  agentId: number;
  decision: AttestDecision | 'error';
  score?: number;
  state?: string;
  txId?: string;
  detail?: string;
}
const outcomes: Outcome[] = [];

for (let t = 0; t < targets.length; t++) {
  const id = targets[t];
  process.stdout.write(`  agent ${String(id).padStart(4)}: `);

  try {
    const agent = await readStellarAgent(server, id);
    const quality = agent?.registration ? scoreMetadataQuality(agent) : null;
    const verdict = classifyTarget({
      agent,
      score: quality?.score ?? null,
      akAccount,
      minScore,
    });

    if (verdict.decision !== 'publish') {
      console.log(`skip — ${verdict.reason}`);
      outcomes.push({ agentId: id, decision: verdict.decision, score: quality?.score, detail: verdict.reason });
      continue;
    }

    const { payload, feedbackUri } = buildStellarAssessment({
      agentId: id,
      akAccount,
      scheme: SCHEME_TAG1,
      version: SCHEME_TAG2,
      score: quality!.score,
      breakdown: quality!.breakdown,
      notes: quality!.notes,
    });

    const result = await publishStellarFeedback(
      {
        agentId: id,
        value: BigInt(quality!.score),
        valueDecimals: 0,
        tag1: SCHEME_TAG1,
        tag2: SCHEME_TAG2,
        endpoint: '',
        feedbackUri,
        feedbackHash: feedbackHashFromJson(payload),
      },
      execute ? 'execute' : 'simulate',
      { server, keypair, caller: akAccount, maxFeeStroops: ceiling },
    );

    if (result.dryRun) {
      const feeXlm = result.feeStroops !== undefined ? `${(result.feeStroops / 1e7).toFixed(4)} XLM` : 'unknown fee';
      console.log(`score ${quality!.score} → would rate (fee ${feeXlm})`);
      outcomes.push({ agentId: id, decision: 'publish', score: quality!.score, state: 'simulated' });
    } else {
      const tag = result.state === 'confirmed' ? '✔' : '⚠';
      console.log(`score ${quality!.score} → ${tag} ${result.state} ${result.txId?.slice(0, 10)}…`);
      if (result.detail) console.log(`              ${result.detail}`);
      outcomes.push({
        agentId: id,
        decision: 'publish',
        score: quality!.score,
        state: result.state,
        txId: result.txId,
        detail: result.detail,
      });
      // One unresolved write is a fact to investigate; three is a mess. If a
      // submission did not confirm, the RPC is not answering reliably right
      // now, so stop rather than pile up ambiguous records. The next run picks
      // up where this one left off — its dedupe sweep sees whatever landed.
      if (result.state !== 'confirmed') {
        const left = targets.slice(t + 1);
        if (left.length > 0) console.log(`  stopping — ${left.length} target(s) untouched: ${left.join(', ')}`);
        break;
      }

      // Spread writes across ledgers rather than firing one bursty nonce run.
      if (jitterSec > 0 && t < targets.length - 1) {
        await sleep(Math.round(jitterSec * 1000 * (0.4 + Math.random() * 1.2)));
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isFeeCeilingError(err)) {
      // Not a transient error and not this agent's fault: the network is
      // charging more than policy allows, so every remaining target would be
      // refused identically. Stop and say so once.
      console.log(`fee ${(Number(err.feeUnits) / 1e7).toFixed(4)} XLM > ceiling — refusing (nothing signed)`);
      outcomes.push({ agentId: id, decision: 'error', detail: msg });
      const left = targets.slice(t + 1);
      if (left.length > 0) console.log(`  stopping — ${left.length} target(s) untouched: ${left.join(', ')}`);
      break;
    }
    console.log(`error: ${msg.slice(0, 100)}`);
    outcomes.push({ agentId: id, decision: 'error', detail: msg });
  }
}

// ─── 5. Summary + exit code ─────────────────────────────────────────────────

console.log('');
console.log('────────────────  summary  ────────────────');
const grouped: Record<string, number> = {};
for (const o of outcomes) {
  const key = o.decision === 'publish' ? (o.state ?? 'published') : o.decision;
  grouped[key] = (grouped[key] ?? 0) + 1;
}
for (const [k, v] of Object.entries(grouped)) console.log(`  ${k.padEnd(18)} ${v}`);

if (execute) {
  for (const o of outcomes.filter((x) => x.txId)) {
    console.log(`  agent ${o.agentId} (${o.state}): https://stellar.expert/explorer/public/tx/${o.txId}`);
  }
} else {
  console.log('');
  console.log('  simulate mode: nothing sent. Re-run with --execute to write.');
}

// An attempt that did not resolve to `confirmed` must page. `indeterminate`
// especially: the write probably landed, and an operator needs to look rather
// than let the next run guess. It is still never resent automatically.
const unresolved = outcomes.filter(
  (o) => o.decision === 'error' || (o.state !== undefined && !['confirmed', 'simulated'].includes(o.state)),
);
if (unresolved.length > 0) {
  console.error('');
  console.error(`[attest] FAILED: ${unresolved.length} attempt(s) did not confirm:`);
  for (const o of unresolved) console.error(`  agent ${o.agentId}: ${o.state ?? o.decision} — ${o.detail ?? ''}`);
  process.exit(1);
}
