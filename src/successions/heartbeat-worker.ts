/**
 * Heartbeat worker — the Dead Man's Switch liveness drain (ALL chains).
 *
 * For each declared, non-terminal succession it:
 *   1. reads the agent's chain-scoped last meaningful tx (the heartbeat),
 *   2. derives the live status + strength via scoring/succession (pure),
 *   3. emits a Tier-2 `heartbeat_observed` (alive) or `heartbeat_lapsed`
 *      (interval elapsed) signal — the four-tier 0.25 cap structurally bounds
 *      any lapse haircut; it NEVER zeros the provider score,
 *   4. persists the derived status + observed heartbeat onto successions + the
 *      denormalized wallet columns.
 *
 * Chain-agnostic: one drain covers solana / celo / arc / stellar uniformly via
 * the composite (chain, agent_wallet) keying — the per-row `chain` drives both
 * the tx read and the writes. AK never executes a will; this is pure OBSERVATION
 * + scoring (RFC §12 Non-Custody).
 *
 * Wired the keep-fresh way (defense-in-depth, no single point of failure):
 *   - in-process interval drain (instrumentation.ts), AND
 *   - external cron route (/api/cron/heartbeat) driven by GitHub Actions.
 * Mirrors the indexer/rescore keep-fresh pattern after the 2026-05/06 ingest
 * stall (in-process worker wedged + servel cron non-functional on this cluster).
 */

import type { Chain, Succession } from '@/db/schema';
import {
  listSuccessionsForHeartbeat,
  getLastMeaningfulTxAt,
  applySuccessionLiveness,
  insertSignalEvents,
  type InsertSignalEventInput,
} from '@/db/client';
import {
  deriveSuccessionLiveness,
  heartbeatStrength,
} from '@/scoring/succession';
import {
  buildHeartbeatObservedSignal,
  buildHeartbeatLapsedSignal,
} from '@/scoring/signals';

const DEFAULT_BATCH_SIZE = 500;

export interface HeartbeatResult {
  /** Successions claimed for evaluation this pass. */
  claimed: number;
  /** Rows whose derived status changed from the stored status. */
  transitioned: number;
  /** heartbeat_observed signals emitted (agent alive within interval/grace). */
  observed: number;
  /** heartbeat_lapsed signals emitted (interval+grace elapsed). */
  lapsed: number;
  /** Rows skipped (no observable activity yet — stays 'declared', no signal). */
  skipped: number;
  errors: { agentWallet: string; chain: Chain; message: string }[];
  elapsedMs: number;
}

/**
 * Evaluate one succession row: derive liveness, emit the heartbeat signal,
 * persist status. Returns the outcome bucket for tallying. DB-bound but pure
 * over the injected row — `now` is injectable for deterministic tests.
 */
export async function evaluateOneHeartbeat(
  succession: Succession,
  now: Date = new Date(),
): Promise<'observed' | 'lapsed' | 'skipped'> {
  // Terminal facts (executed/revoked) are settled — never derive liveness or
  // emit a heartbeat for them. The list query already excludes these, but guard
  // here too so a direct call can't resurrect a heartbeat on a closed will.
  if (succession.status === 'executed' || succession.status === 'revoked') {
    await applySuccessionLiveness({
      agentWallet: succession.agent_wallet,
      chain: succession.chain,
      status: succession.status,
      heartbeatLastAt: succession.last_heartbeat_at,
    });
    return 'skipped';
  }

  const lastTxAt = await getLastMeaningfulTxAt(succession.agent_wallet, succession.chain);

  const liveness = deriveSuccessionLiveness({
    succession: { status: succession.status, interval_seconds: succession.interval_seconds },
    lastMeaningfulTxAt: lastTxAt,
    now,
  });

  // No observable activity since declaring — can't assert liveness. Persist the
  // 'declared' baseline (idempotent) and emit NO signal: a thin/no-data agent is
  // never penalized for the absence of a heartbeat it never had a chance to send.
  if (liveness.secondsSinceHeartbeat == null) {
    await applySuccessionLiveness({
      agentWallet: succession.agent_wallet,
      chain: succession.chain,
      status: liveness.status,
      heartbeatLastAt: liveness.heartbeatLastAt,
    });
    return 'skipped';
  }

  const isLapsed = liveness.status === 'lapsed';
  const signal: InsertSignalEventInput = isLapsed
    ? buildHeartbeatLapsedSignal(succession.agent_wallet, {
        // Haircut magnitude grows as the agent falls further past its deadline;
        // value carries the (positive) magnitude — the Tier-2 cap bounds it.
        haircut: 1 - heartbeatStrength(liveness.secondsSinceHeartbeat, succession.interval_seconds),
        lapsedAt: liveness.heartbeatLastAt ?? now.toISOString(),
        intervalSeconds: succession.interval_seconds,
      })
    : buildHeartbeatObservedSignal(succession.agent_wallet, {
        strength: heartbeatStrength(liveness.secondsSinceHeartbeat, succession.interval_seconds),
        lastHeartbeatAt: liveness.heartbeatLastAt ?? now.toISOString(),
        intervalSeconds: succession.interval_seconds,
      });

  // Set chain on the signal so the FK + dedup index resolve to the right row.
  signal.chain = succession.chain;
  await insertSignalEvents([signal], { overwrite: true });

  await applySuccessionLiveness({
    agentWallet: succession.agent_wallet,
    chain: succession.chain,
    status: liveness.status,
    heartbeatLastAt: liveness.heartbeatLastAt,
  });

  return isLapsed ? 'lapsed' : 'observed';
}

/**
 * Drain one bounded batch of heartbeat evaluations across ALL chains. Idempotent
 * + safe to run concurrently (signal upserts + status writes are idempotent).
 */
export async function drainHeartbeatsOnce(
  batchSize = DEFAULT_BATCH_SIZE,
  chain?: Chain,
  now: Date = new Date(),
): Promise<HeartbeatResult> {
  const start = Date.now();
  const rows = await listSuccessionsForHeartbeat(batchSize, chain);

  let observed = 0;
  let lapsed = 0;
  let skipped = 0;
  let transitioned = 0;
  const errors: HeartbeatResult['errors'] = [];

  for (const row of rows) {
    try {
      const outcome = await evaluateOneHeartbeat(row, now);
      if (outcome === 'observed') observed++;
      else if (outcome === 'lapsed') lapsed++;
      else skipped++;
      // Cheap transition tally: 'live'/'lapsing' map to observed, 'lapsed' to
      // lapsed, 'declared' to skipped — compare against the stored status.
      const stored = row.status;
      const derivedBucket = outcome === 'skipped' ? 'declared' : outcome === 'lapsed' ? 'lapsed' : 'live-band';
      const storedBucket =
        stored === 'lapsed' ? 'lapsed' : stored === 'declared' ? 'declared' : 'live-band';
      if (derivedBucket !== storedBucket) transitioned++;
    } catch (err) {
      errors.push({
        agentWallet: row.agent_wallet,
        chain: row.chain,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    claimed: rows.length,
    transitioned,
    observed,
    lapsed,
    skipped,
    errors,
    elapsedMs: Date.now() - start,
  };
}

export const HEARTBEAT_DEFAULT_BATCH_SIZE = DEFAULT_BATCH_SIZE;
