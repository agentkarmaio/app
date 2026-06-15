/**
 * Shared serializers for succession + bond + surety API blocks.
 *
 * Used by both the dedicated /api/v2/succession + /api/v2/bond endpoints and the
 * additive blocks on /api/v2/score, so every surface emits one stable shape.
 *
 * INVARIANTS reflected here (see docs/BONDING-AND-SUCCESSION-DESIGN.md):
 *   - AK is OBSERVE-ONLY: no field implies AK holds funds or executes a will.
 *   - Demo/seeded bonds carry `isDemo: true` and MUST stay flagged.
 *   - Surety is an ORTHOGONAL axis — its own block, never folded into karma.
 *   - A bond/will lifts confidence + Tier-presence ONLY; nothing here raises a
 *     trust ceiling (ceiling discipline is enforced in the scoring layer).
 */

import type {
  Succession, SuccessionHeir, SuccessionStatus, Bond, BondStatus, BondUnderwriter,
} from '@/db/schema';
import type { SuccessionLivenessResult } from '@/scoring/succession';
import type { SuretyResult, SuretyPosition } from '@/scoring/surety';

// --- Succession --------------------------------------------------------------

export interface SuccessionView {
  /** Live derived status (overrides the stored value with liveness). */
  status: SuccessionStatus;
  /** Stored status straight from the row (terminal facts vs derived liveness). */
  declaredStatus: SuccessionStatus;
  sourceType: string;
  intervalSeconds: number;
  heirCount: number;
  heirs: SuccessionHeir[];
  /** Witness anchor for a future on-chain will; null in the no-contract MVP. */
  willHash: string | null;
  declaredAt: string;
  /** AK's OBSERVED heartbeat (last meaningful tx), null when none seen. */
  lastHeartbeatAt: string | null;
  secondsSinceHeartbeat: number | null;
  /** lastHeartbeat + interval — when the agent next reads lapsing. */
  deadlineAt: string | null;
  lapsedAt: string | null;
  executedAt: string | null;
  revokedAt: string | null;
}

export function buildSuccessionView(
  s: Succession,
  liveness: SuccessionLivenessResult,
): SuccessionView {
  const heirs = Array.isArray(s.heirs) ? s.heirs : [];
  return {
    status: liveness.status,
    declaredStatus: s.status,
    sourceType: s.source_type,
    intervalSeconds: s.interval_seconds,
    heirCount: heirs.length,
    heirs,
    willHash: s.will_hash,
    declaredAt: s.declared_at,
    lastHeartbeatAt: liveness.heartbeatLastAt ?? s.last_heartbeat_at,
    secondsSinceHeartbeat: liveness.secondsSinceHeartbeat,
    deadlineAt: liveness.deadlineAt,
    lapsedAt: s.lapsed_at,
    executedAt: s.executed_at,
    revokedAt: s.revoked_at,
  };
}

// --- Bonds -------------------------------------------------------------------

export interface BondView {
  id: string;
  beneficiary: string;
  taskRef: string | null;
  amount: number;
  currency: string;
  status: BondStatus;
  escrowRef: string;
  resolutionProofTx: string | null;
  /** Seeded/demo row — UI MUST label it; not a real on-chain bond. */
  isDemo: boolean;
  openedAt: string;
  resolvedAt: string | null;
}

export function buildBondView(b: Bond): BondView {
  return {
    id: b.id,
    beneficiary: b.beneficiary,
    taskRef: b.task_ref,
    amount: Number(b.amount),
    currency: b.currency,
    status: b.status,
    escrowRef: b.escrow_ref,
    resolutionProofTx: b.resolution_proof_tx,
    isDemo: b.is_demo,
    openedAt: b.opened_at,
    resolvedAt: b.resolved_at,
  };
}

/** A bond is "settled" once it has resolved either way (not open/expired). */
export function isBondSettled(status: BondStatus): boolean {
  return status === 'resolved_success' || status === 'resolved_failure';
}

/** Map an underwriting position (+ its bond) into a SuretyPosition. */
export function toSuretyPosition(
  u: BondUnderwriter & { bond: Bond | null },
): SuretyPosition {
  const status = u.bond?.status;
  const settled = status != null && isBondSettled(status);
  return {
    settled,
    success: status === 'resolved_success',
    stakeAmount: Number(u.stake_amount),
  };
}

// --- Surety ------------------------------------------------------------------

export interface SuretyView {
  score: number;
  label: SuretyResult['label'];
  settledCount: number;
  successCount: number;
  inFlightCount: number;
  totalCount: number;
}

export function buildSuretyView(r: SuretyResult): SuretyView {
  return {
    score: r.score,
    label: r.label,
    settledCount: r.settledCount,
    successCount: r.successCount,
    inFlightCount: r.inFlightCount,
    totalCount: r.totalCount,
  };
}
