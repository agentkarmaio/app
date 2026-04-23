/**
 * Karma Scoring Engine — four-tier weighted blend (Phase F).
 *
 * See docs/SIGNAL-ARCHITECTURE.md for the canonical specification.
 *
 *   Score = clamp( Σ_k (w_k * tier_k_aggregate), 0, 100 )
 *     where (w1, w2, w3, w4) = (0.60, 0.25, 0.10, 0.05)
 *
 * When a tier has no signals, its weight is **redistributed proportionally**
 * across tiers that do have signals — new agents with strong Tier 2 behavior
 * are not zero-penalized for lacking Tier 1 receipts.
 *
 * Legacy `calculateScore(transactions, attestation, feedback*)` is preserved
 * as a thin adapter that derives Tier 1 (attestation) + Tier 2 (behavioral)
 * aggregates from raw x402 transactions.
 */

import type { ConfidenceBadge, SignalTier } from '@/db/schema';

export type TrustTier = 'Unrated' | 'Poor' | 'Fair' | 'Good' | 'Very Good' | 'Excellent';

// ─── Tier Weights ─────────────────────────────────────────────────────────────

export const TIER_WEIGHTS: Record<SignalTier, number> = {
  1: 0.60,
  2: 0.25,
  3: 0.10,
  4: 0.05,
} as const;

export interface TierAggregates {
  tier1?: number | null;
  tier2?: number | null;
  tier3?: number | null;
  tier4?: number | null;
}

export interface TieredScoreResult {
  score: number;
  trustTier: TrustTier;
  effectiveWeights: Record<SignalTier, number>;
  confidenceBadge: ConfidenceBadge;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function cap(value: number, max: number): number {
  return Math.min(value / max, 1.0);
}

function recencyDecay(daysSinceLastTx: number): number {
  if (daysSinceLastTx <= 7) return 1.0;
  if (daysSinceLastTx <= 30) return 1.0 - 0.05 * ((daysSinceLastTx - 7) / 23);
  if (daysSinceLastTx <= 90) return 0.95 - 0.10 * ((daysSinceLastTx - 30) / 60);
  return 0.80;
}

export function getTrustTier(score: number): TrustTier {
  if (score <= 20) return 'Unrated';
  if (score <= 40) return 'Poor';
  if (score <= 60) return 'Fair';
  if (score <= 75) return 'Good';
  if (score <= 90) return 'Very Good';
  return 'Excellent';
}

// ─── Evidence-gated tier progression ──────────────────────────────────────────
//
// A raw numeric score alone does not earn a tier label. A wallet must present
// enough observable evidence for the label to be truthful — otherwise a fresh
// 100%-success wallet with one counterparty can inherit "Very Good" just
// because Tier-2 weight redistribution pulled its aggregate up.
//
// Two independent axes gate the ceiling:
//   behavioral thickness — none / moderate / thick (by tx count, diversity, age)
//   Tier-1 receipts      — none / some / strong
// The ceiling is looked up via a 3×3 table; the numeric tier is the floor
// (a genuinely low score still reads as Poor/Fair regardless of thickness).

export interface TierEvidence {
  txCount: number;
  counterparties: number;
  daysActive: number;
  hasTier1Receipts: boolean;
  tier1Strong: boolean;
}

const TIER_RANK: Record<TrustTier, number> = {
  Unrated: 0, Poor: 1, Fair: 2, Good: 3, 'Very Good': 4, Excellent: 5,
};

function tierMin(a: TrustTier, b: TrustTier): TrustTier {
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}

// [behavioral thickness][receipt strength] → ceiling tier
// rows: thin · moderate · thick   cols: none · some · strong
const EVIDENCE_CEILING: TrustTier[][] = [
  ['Fair',      'Good',      'Very Good'],
  ['Good',      'Very Good', 'Very Good'],
  ['Very Good', 'Very Good', 'Excellent'],
];

export function evidenceGatedTier(score: number, evidence: TierEvidence): TrustTier {
  const numeric = getTrustTier(score);
  if (evidence.txCount === 0 && !evidence.hasTier1Receipts) return numeric;

  const moderate =
    evidence.txCount >= 50 &&
    evidence.counterparties >= 3 &&
    evidence.daysActive >= 14;
  const thick =
    evidence.txCount >= 200 &&
    evidence.counterparties >= 10 &&
    evidence.daysActive >= 30;

  const behaviorLevel = thick ? 2 : moderate ? 1 : 0;
  const receiptLevel = evidence.tier1Strong ? 2 : evidence.hasTier1Receipts ? 1 : 0;
  const ceiling = EVIDENCE_CEILING[behaviorLevel][receiptLevel];

  return tierMin(numeric, ceiling);
}

// ─── Tier blend + confidence badge ────────────────────────────────────────────

export function getConfidenceBadge(aggregates: TierAggregates): ConfidenceBadge {
  const has = (v: number | null | undefined) => typeof v === 'number' && v >= 0;
  if (has(aggregates.tier1)) return 'receipt-backed';
  if (has(aggregates.tier2) || has(aggregates.tier3)) return 'behavior-inferred';
  return 'declared';
}

export function calculateTieredScore(
  aggregates: TierAggregates,
  opts: { decay?: number } = {},
): TieredScoreResult {
  const present = ([1, 2, 3, 4] as SignalTier[]).filter((t) => {
    const key = `tier${t}` as const;
    const v = aggregates[key];
    return typeof v === 'number' && Number.isFinite(v);
  });

  const effectiveWeights: Record<SignalTier, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };

  if (present.length === 0) {
    return {
      score: 0,
      trustTier: getTrustTier(0),
      effectiveWeights,
      confidenceBadge: 'declared',
    };
  }

  const presentWeightSum = present.reduce((sum, t) => sum + TIER_WEIGHTS[t], 0);

  let raw = 0;
  for (const t of present) {
    const w = TIER_WEIGHTS[t] / presentWeightSum;
    effectiveWeights[t] = w;
    const v = clamp01(aggregates[`tier${t}` as const] as number);
    raw += w * v;
  }

  const decay = opts.decay ?? 1.0;
  const score = Math.round(raw * decay * 100 * 100) / 100;

  return {
    score,
    trustTier: getTrustTier(score),
    effectiveWeights,
    confidenceBadge: getConfidenceBadge(aggregates),
  };
}

// ─── Legacy x402 adapter ──────────────────────────────────────────────────────

interface ScoringTransaction {
  wallet_address: string;
  facilitator: string;
  amount: number;
  timestamp: string | Date;
  success: boolean;
  tx_signature: string;
}

export interface WalletScore {
  address: string;
  /** Back-compat: mirrors providerScore. */
  score: number;
  providerScore: number;
  consumerScore: number | null;
  /** Back-compat: provider-face tier label. */
  trustTier: TrustTier;
  /** Back-compat: provider-face confidence. */
  confidenceBadge: ConfidenceBadge;
  metrics: {
    successRate: number;
    diversity: number;
    volume: number;
    age: number;
    attestation: number;
    /** Automation-likelihood from cadence analysis (null if <10 tx). */
    cadence: number | null;
  };
  tierAggregates: TierAggregates;
  /** Consumer-face breakout — null when txs are absent. */
  consumerFace: ConsumerFaceScore | null;
  txCount: number;
  lastActive: Date;
}

export interface ConsumerFaceScore {
  /** 0–100. */
  score: number;
  trustTier: TrustTier;
  confidenceBadge: ConfidenceBadge;
  /** Tier-2-only aggregate; single-tier so no redistribution needed. */
  tierAggregates: TierAggregates;
  /** Weighted contributions inside Tier 2 for display. */
  metrics: {
    successRate: number;
    diversity: number;
    volume: number;
    age: number;
    cadence: number | null;
  };
}

// Consumer-face Tier 2 weights put more emphasis on payment reliability +
// volume (does this wallet pay cleanly and often?) and less on age/diversity
// than the provider face, which weights stability + breadth more heavily.
const CONSUMER_TIER2_METRIC_WEIGHTS = {
  successRate: 0.30,
  diversity:   0.15,
  volume:      0.30,
  age:         0.15,
  // +10% cadence blend (same behavior as provider face)
} as const;

const NORMALIZE = {
  diversityMax: 10,
  volumeMax: 500,
  ageMax: 180,
} as const;

const TIER2_METRIC_WEIGHTS = {
  successRate: 0.35,
  diversity: 0.25,
  volume: 0.20,
  age: 0.20,
} as const;

export function calculateScore(
  transactions: ScoringTransaction[],
  attestation = 0,
  feedbackDeliveryRate?: number,
  feedbackCount?: number,
  cadenceScore?: number | null,
  manifestScore?: number | null,
): WalletScore {
  if (transactions.length === 0) {
    throw new Error('calculateScore requires at least one transaction');
  }

  const address = transactions[0].wallet_address;
  const txCount = transactions.length;

  const successCount = transactions.filter((tx) => tx.success).length;
  const successRate = txCount > 0 ? successCount / txCount : 0;

  const uniqueFacilitators = new Set(transactions.map((tx) => tx.facilitator)).size;
  const diversity = cap(uniqueFacilitators, NORMALIZE.diversityMax);

  const volume = cap(txCount, NORMALIZE.volumeMax);

  const timestamps = transactions.map((tx) => new Date(tx.timestamp).getTime());
  const firstTs = Math.min(...timestamps);
  const lastTs = Math.max(...timestamps);
  const daysActive = (Date.now() - firstTs) / MS_PER_DAY;
  const age = cap(daysActive, NORMALIZE.ageMax);

  const legacyTier2 =
    successRate * TIER2_METRIC_WEIGHTS.successRate +
    diversity * TIER2_METRIC_WEIGHTS.diversity +
    volume * TIER2_METRIC_WEIGHTS.volume +
    age * TIER2_METRIC_WEIGHTS.age;

  // Blend in cadence when available (G2). Cadence is a behavioral shape
  // signal — contributes 10% of Tier 2 so legacy metrics still dominate.
  const cadenceClamped = typeof cadenceScore === 'number'
    ? clamp01(cadenceScore)
    : null;
  const tier2 = cadenceClamped != null
    ? legacyTier2 * 0.9 + cadenceClamped * 0.1
    : legacyTier2;

  // Tier 1 — receipt-gated attestation (8004 + local tx-referenced feedback).
  // Local weighted 60% because it's anchored to a tx_signature.
  const onChain = clamp01(attestation);
  const hasLocal = typeof feedbackCount === 'number' && feedbackCount > 0
    && typeof feedbackDeliveryRate === 'number';
  let tier1: number | null = null;
  let blendedAttestation = 0;
  if (hasLocal) {
    const local = clamp01(feedbackDeliveryRate as number);
    blendedAttestation = onChain * 0.4 + local * 0.6;
    tier1 = blendedAttestation;
  } else if (onChain > 0) {
    blendedAttestation = onChain;
    tier1 = onChain;
  }

  // Tier 3 from manifest signal (Phase H1). Tier 4 deferred.
  const tier3 = typeof manifestScore === 'number' ? clamp01(manifestScore) : null;
  const aggregates: TierAggregates = { tier1, tier2, tier3, tier4: null };

  const daysSinceLastTx = (Date.now() - lastTs) / MS_PER_DAY;
  const decay = recencyDecay(daysSinceLastTx);

  const tiered = calculateTieredScore(aggregates, { decay });

  // Evidence-gated tier progression. See evidenceGatedTier() for rationale —
  // numeric score is the floor, behavioral thickness + receipt strength set
  // the ceiling. Thin-file wallets can't reach Very Good on Tier 2 alone.
  const providerEvidence: TierEvidence = {
    txCount,
    counterparties: uniqueFacilitators,
    daysActive,
    hasTier1Receipts: tier1 != null && tier1 > 0,
    tier1Strong: tier1 != null && tier1 >= 0.7,
  };
  const providerTier = evidenceGatedTier(tiered.score, providerEvidence);

  // ─── Consumer face — payment-behavior view (Phase I) ────────────────────────
  //
  // Same inputs but re-weighted to reflect "does this wallet pay cleanly and
  // often?" Tier 2 only; confidence badge is always 🟡 behavior-inferred at
  // this stage because the consumer face doesn't yet consume Tier 1 dispute
  // signals (Phase I2+).
  const consumerLegacyTier2 =
    successRate * CONSUMER_TIER2_METRIC_WEIGHTS.successRate +
    diversity   * CONSUMER_TIER2_METRIC_WEIGHTS.diversity +
    volume      * CONSUMER_TIER2_METRIC_WEIGHTS.volume +
    age         * CONSUMER_TIER2_METRIC_WEIGHTS.age;
  const consumerTier2 = cadenceClamped != null
    ? consumerLegacyTier2 * 0.9 + cadenceClamped * 0.1
    : consumerLegacyTier2;

  const consumerAggregates: TierAggregates = { tier1: null, tier2: consumerTier2, tier3: null, tier4: null };
  const consumerTiered = calculateTieredScore(consumerAggregates, { decay });
  // Consumer face doesn't yet consume Tier-1 dispute signals (Phase I2+), so
  // the receipt axis is always zero here; thickness alone gates the tier.
  const consumerTier = evidenceGatedTier(consumerTiered.score, {
    txCount,
    counterparties: uniqueFacilitators,
    daysActive,
    hasTier1Receipts: false,
    tier1Strong: false,
  });
  const consumerFace: ConsumerFaceScore = {
    score: consumerTiered.score,
    trustTier: consumerTier,
    confidenceBadge: consumerTiered.confidenceBadge,
    tierAggregates: consumerAggregates,
    metrics: { successRate, diversity, volume, age, cadence: cadenceClamped },
  };

  return {
    address,
    score: tiered.score,
    providerScore: tiered.score,
    consumerScore: consumerFace.score,
    trustTier: providerTier,
    confidenceBadge: tiered.confidenceBadge,
    metrics: {
      successRate,
      diversity,
      volume,
      age,
      attestation: blendedAttestation,
      cadence: cadenceClamped,
    },
    tierAggregates: aggregates,
    consumerFace,
    txCount,
    lastActive: new Date(lastTs),
  };
}

export function calculateScores(
  allTransactions: ScoringTransaction[],
  attestations?: Map<string, number>,
  cadenceScores?: Map<string, number>,
  manifestScores?: Map<string, number>,
): Map<string, WalletScore> {
  const byWallet = new Map<string, ScoringTransaction[]>();
  for (const tx of allTransactions) {
    const group = byWallet.get(tx.wallet_address) ?? [];
    group.push(tx);
    byWallet.set(tx.wallet_address, group);
  }

  const scores = new Map<string, WalletScore>();
  for (const [address, txs] of byWallet) {
    scores.set(
      address,
      calculateScore(
        txs,
        attestations?.get(address) ?? 0,
        undefined,
        undefined,
        cadenceScores?.get(address) ?? null,
        manifestScores?.get(address) ?? null,
      ),
    );
  }

  return scores;
}
