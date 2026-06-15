/**
 * Succession status derivation — the Dead Man's Switch liveness read.
 *
 * AK OBSERVES the public succession lifecycle; it never holds a key, never holds
 * funds, never executes a will (RFC §12 Non-Routing AND Non-Custody). This module
 * is pure derivation: given a declared `successions` row + the wallet's last
 * meaningful tx, it computes the live `succession_status` denormalized onto
 * `wallets.succession_status` and the `wallets.heartbeat_last_at` it observed.
 *
 * Liveness bands (vs the declared `interval_seconds`):
 *   live     — last meaningful tx within the interval
 *   lapsing  — past the interval but within the warning grace band
 *   lapsed   — past interval + grace; succession conditions met
 *
 * Terminal on-chain states OVERRIDE liveness derivation (they are facts, not
 * inferences): `revoked` (owner reclaimed) and `executed` (inheritance settled
 * on-chain) are taken straight from the row.
 *
 * ORTHOGONALITY (docs/BONDING-AND-SUCCESSION-DESIGN.md §4.1): succession liveness
 * feeds Provider DURABILITY only — NEVER Autonomy. The same raw heartbeat (last
 * meaningful tx) is read independently by computeAutonomy for cadence; the two
 * axes must never double-count one observation. This module deliberately knows
 * nothing about Autonomy and returns only durability-facing fields.
 */

import type { Succession, SuccessionStatus } from '@/db/schema';

/**
 * Fraction of the declared interval, past the deadline, that still reads
 * "lapsing" (a warning band) before flipping to "lapsed". 0.5 = an agent gets
 * an extra half-interval of grace before succession conditions are deemed met.
 */
export const LAPSING_GRACE_FRACTION = 0.5;

export interface SuccessionLivenessInput {
  /** The declared will. */
  succession: Pick<Succession, 'status' | 'interval_seconds'>;
  /**
   * Last meaningful on-chain tx AK observed for this agent (the heartbeat). Null
   * when the agent has no indexed activity since declaring.
   */
  lastMeaningfulTxAt: string | Date | null;
  /** Evaluation time (defaults to now). Injected for deterministic tests. */
  now?: Date;
}

export interface SuccessionLivenessResult {
  /** Derived status to write to `wallets.succession_status`. */
  status: SuccessionStatus;
  /**
   * Heartbeat AK observed, to write to `wallets.heartbeat_last_at`. Echoes the
   * last meaningful tx (ISO). Null when there is none.
   */
  heartbeatLastAt: string | null;
  /** Seconds since the last meaningful tx (null when never seen). */
  secondsSinceHeartbeat: number | null;
  /** Deadline = lastMeaningfulTx + interval (ISO). Null when never seen. */
  deadlineAt: string | null;
}

function toDate(v: string | Date): Date {
  return typeof v === 'string' ? new Date(v) : v;
}

/**
 * Derive the live succession status + observed heartbeat from a declared will.
 *
 * Pure function. Terminal states (`executed`, `revoked`) pass through unchanged.
 * Otherwise the status is derived from liveness bands against `interval_seconds`.
 */
export function deriveSuccessionLiveness(
  input: SuccessionLivenessInput,
): SuccessionLivenessResult {
  const now = input.now ?? new Date();
  const { status: declaredStatus, interval_seconds } = input.succession;

  const lastTs = input.lastMeaningfulTxAt != null
    ? toDate(input.lastMeaningfulTxAt)
    : null;
  const heartbeatLastAt = lastTs ? lastTs.toISOString() : null;

  // Terminal on-chain facts override liveness inference.
  if (declaredStatus === 'executed' || declaredStatus === 'revoked') {
    const secondsSince = lastTs
      ? Math.max(0, (now.getTime() - lastTs.getTime()) / 1000)
      : null;
    return {
      status: declaredStatus,
      heartbeatLastAt,
      secondsSinceHeartbeat: secondsSince,
      deadlineAt: lastTs
        ? new Date(lastTs.getTime() + interval_seconds * 1000).toISOString()
        : null,
    };
  }

  // No observed activity since declaring — can't assert liveness; stays as the
  // declared baseline (caller seeds 'declared' on first registration).
  if (!lastTs) {
    return {
      status: 'declared',
      heartbeatLastAt: null,
      secondsSinceHeartbeat: null,
      deadlineAt: null,
    };
  }

  const secondsSince = Math.max(0, (now.getTime() - lastTs.getTime()) / 1000);
  const deadlineAt = new Date(lastTs.getTime() + interval_seconds * 1000).toISOString();
  const graceSeconds = interval_seconds * (1 + LAPSING_GRACE_FRACTION);

  let status: SuccessionStatus;
  if (secondsSince <= interval_seconds) {
    status = 'live';
  } else if (secondsSince <= graceSeconds) {
    status = 'lapsing';
  } else {
    status = 'lapsed';
  }

  return { status, heartbeatLastAt, secondsSinceHeartbeat: secondsSince, deadlineAt };
}

/**
 * Recency-decayed heartbeat strength in [0,1], for the `heartbeat_observed`
 * Tier-2 signal value. 1.0 well within the interval, decaying toward 0 as the
 * agent approaches (and passes) its deadline. Feeds Provider durability ONLY.
 */
export function heartbeatStrength(
  secondsSinceHeartbeat: number,
  intervalSeconds: number,
): number {
  if (intervalSeconds <= 0) return 0;
  const ratio = secondsSinceHeartbeat / intervalSeconds;
  if (ratio <= 0.5) return 1.0;
  if (ratio >= 1.5) return 0.0;
  // Linear decay from 1.0 (at 0.5×interval) to 0.0 (at 1.5×interval).
  return Math.max(0, Math.min(1, 1 - (ratio - 0.5)));
}
