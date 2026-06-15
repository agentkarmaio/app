/**
 * Surety Karma — the underwriter-quality axis (RFC §6.x, modeled on Autonomy).
 *
 * Answers "how good is this wallet at judging which agents deliver?" Derived
 * from a wallet's `bond_underwriters` outcomes: when bonds it underwrote
 * resolve, did the bonded agent deliver (premium earned) or fail (stake lost)?
 *
 * ORTHOGONAL AXIS — like Autonomy, Surety Karma MUST NOT be folded into the
 * wallet's own Provider or Consumer score. A wallet's skill as an underwriter
 * is independent of its skill as an agent. Denormalized onto
 * `wallets.surety_score` / `wallets.surety_label`; rendered in its own chip.
 *
 * Score shape (0–100):
 *   - success rate over SETTLED bonds is the spine
 *   - volume ramp prevents a single lucky 1/1 from reading "reliable"
 *   - unsettled (in-flight) bonds count toward presence but not the rate
 *
 * Label mapping:
 *   reliable  — ≥ RELIABLE_MIN_SCORE with enough settled volume
 *   mixed     — has settled outcomes but below the reliable bar
 *   unproven  — no settled outcomes yet (only in-flight or none)
 */

import type { SuretyLabel } from '@/db/schema';

export type { SuretyLabel };

/** Minimum settled bonds before a wallet can read "reliable". */
export const SURETY_MIN_SETTLED_FOR_RELIABLE = 3;

/** Score at/above which a sufficiently-active underwriter reads "reliable". */
export const RELIABLE_MIN_SCORE = 70;

/**
 * A single underwriting position, projected from `bond_underwriters` joined to
 * its bond outcome. Pass only the fields the derivation needs — callers can map
 * `BondUnderwriter` + `Bond.status` into this shape.
 */
export interface SuretyPosition {
  /** Has the bond this position backs resolved (success OR failure)? */
  settled: boolean;
  /** True only when settled AND the bonded agent delivered. */
  success: boolean;
  /** Stake size (USDC). Used for volume weighting; defaults to 0 if unknown. */
  stakeAmount?: number;
}

export interface SuretyResult {
  /** 0–100. */
  score: number;
  label: SuretyLabel;
  /** Bonds the wallet underwrote that have resolved. */
  settledCount: number;
  /** Settled bonds where the bonded agent delivered. */
  successCount: number;
  /** Bonds still in flight (counted for presence, not for the rate). */
  inFlightCount: number;
  /** Total positions (settled + in-flight). */
  totalCount: number;
}

function clampUnit(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function labelFor(score: number, settledCount: number): SuretyLabel {
  if (settledCount === 0) return 'unproven';
  if (settledCount >= SURETY_MIN_SETTLED_FOR_RELIABLE && score >= RELIABLE_MIN_SCORE) {
    return 'reliable';
  }
  return 'mixed';
}

/**
 * Compute Surety Karma from a wallet's underwriting positions.
 *
 * Returns null when the wallet has underwritten nothing — callers should leave
 * `surety_score`/`surety_label` NULL (no axis to show).
 */
export function computeSurety(positions: SuretyPosition[]): SuretyResult | null {
  if (positions.length === 0) return null;

  const settled = positions.filter((p) => p.settled);
  const settledCount = settled.length;
  const successCount = settled.filter((p) => p.success).length;
  const inFlightCount = positions.length - settledCount;

  // No settled outcomes yet — present but unproven. Score stays 0 (no evidence
  // of judgment), but the wallet IS surfaced so in-flight underwriting shows.
  if (settledCount === 0) {
    return {
      score: 0,
      label: 'unproven',
      settledCount: 0,
      successCount: 0,
      inFlightCount,
      totalCount: positions.length,
    };
  }

  const successRate = successCount / settledCount;
  // Volume ramp: a 1/1 underwriter is not yet "reliable". Saturate at the
  // reliable-min threshold so 3+ settled bonds unlock full credit for the rate.
  const volumeRamp = clampUnit(settledCount / SURETY_MIN_SETTLED_FOR_RELIABLE);

  const raw = successRate * volumeRamp;
  const score = Math.round(raw * 100 * 100) / 100;

  return {
    score,
    label: labelFor(score, settledCount),
    settledCount,
    successCount,
    inFlightCount,
    totalCount: positions.length,
  };
}
