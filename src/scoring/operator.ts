/**
 * Operator (provider-side) scoring for pay.sh gateways.
 *
 * pay.sh operators (e.g. Google Cloud APIs `Cs2zdf…uEqP`, paysponge
 * `7r4e5d…NXWw`) are not x402-flow payers themselves — they appear on-chain
 * as the recipients + fee-payer signers of multi-split settlements they
 * broadcast after delivering an API response. They therefore have no rows in
 * the `transactions` table and cannot be scored by `calculateScore()` (which
 * requires ≥1 transaction).
 *
 * This module provides a parallel scoring path that derives Provider Karma
 * for operators from their `paysh_routed` provider-face signal_events:
 *
 *   - receiptCount    — number of pay.sh-routed settlements broadcast
 *   - uniquePayerCount — how many distinct agent wallets paid through the
 *                        operator (counterparty diversity proxy)
 *   - lastSeen        — recency, for liveness decay
 *
 * Higher uniquePayerCount and steady receipt flow → higher Provider Karma.
 * A single high-volume operator routed by a tight payer cluster scores lower
 * than a lower-volume operator with diverse counterparties — same anti-sybil
 * shape as the main scoring engine, just computed differently because the
 * input shape is different (no transactions to inspect, only signal events).
 */

import type { ConfidenceBadge, TrustTier } from '@/db/schema';

const MS_PER_DAY = 86_400_000;

export interface OperatorScoreInput {
  receiptCount: number;
  uniquePayerCount: number;
  /** Most recent observed_at timestamp across this operator's signals. */
  lastSeen?: Date | string | null;
}

export interface OperatorScore {
  /** 0-100 Provider Karma. */
  score: number;
  trustTier: TrustTier;
  confidenceBadge: ConfidenceBadge;
}

/**
 * Compute Provider Karma for a pay.sh operator from its provider-face
 * `paysh_routed` signals.
 *
 * Curve rationale: the operator's broadcast IS the attestation (RFC v0.3.2 §4.1),
 * so even a single receipt is a strong signal. Diversity is the differentiator —
 * an operator serving 1 caller 1000 times is structurally less trustworthy than
 * one serving 100 callers 10 times each (sybil signal). Volume contributes
 * sub-linearly so volume-only operators don't max out without diverse demand.
 *
 * Liveness: any signal in the last 7d keeps full strength; linearly decays to
 * 0.75x at 90d (matching the main engine's recency curve).
 */
export function calculateOperatorScore(input: OperatorScoreInput): OperatorScore {
  const { receiptCount, uniquePayerCount } = input;

  if (receiptCount <= 0) {
    return { score: 0, trustTier: 'Unrated', confidenceBadge: 'declared' };
  }

  // Diversity term — log-scaled, capped. 1 payer = 0, 10 payers ≈ 0.5,
  // 100 payers ≈ 0.85, 500 payers ≈ 1.0.
  const diversity = clamp01(Math.log10(Math.max(1, uniquePayerCount)) / 2.7);

  // Volume term — log-scaled, sub-linear. 1 receipt ≈ 0, 10 ≈ 0.4,
  // 100 ≈ 0.7, 1000 ≈ 0.9, 10000 ≈ 1.0.
  const volume = clamp01(Math.log10(Math.max(1, receiptCount)) / 4);

  // Provider Karma blend: diversity dominates (60%), volume secondary (30%),
  // base receipt-backed bonus (10%) — every operator that ever broadcast
  // a pay.sh settlement clears 10 points.
  const base = 10;
  const raw = base + 60 * diversity + 30 * volume;

  // Recency multiplier — 1.0 if active in last 7d, decaying linearly to
  // 0.75 by 90d, then floor.
  const recency = recencyMultiplier(input.lastSeen ?? null);
  const score = clamp(raw * recency, 0, 100);

  const confidenceBadge: ConfidenceBadge = receiptCount >= 3
    ? 'receipt-backed'
    : 'behavior-inferred';

  return {
    score: round2(score),
    trustTier: tierForScore(score),
    confidenceBadge,
  };
}

function recencyMultiplier(lastSeen: Date | string | null): number {
  if (!lastSeen) return 0.75;
  const ts = typeof lastSeen === 'string' ? new Date(lastSeen).getTime() : lastSeen.getTime();
  if (!Number.isFinite(ts)) return 0.75;
  const daysSince = (Date.now() - ts) / MS_PER_DAY;
  if (daysSince <= 7) return 1.0;
  if (daysSince >= 90) return 0.75;
  return 1.0 - (0.25 * (daysSince - 7) / (90 - 7));
}

function tierForScore(score: number): TrustTier {
  if (score >= 80) return 'Excellent';
  if (score >= 65) return 'Very Good';
  if (score >= 50) return 'Good';
  if (score >= 30) return 'Fair';
  if (score > 0) return 'Poor';
  return 'Unrated';
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function clamp01(n: number): number {
  return clamp(n, 0, 1);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
