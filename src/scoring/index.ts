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
  score: number;
  providerScore: number;
  consumerScore: number | null;
  trustTier: TrustTier;
  confidenceBadge: ConfidenceBadge;
  metrics: {
    successRate: number;
    diversity: number;
    volume: number;
    age: number;
    attestation: number;
  };
  tierAggregates: TierAggregates;
  txCount: number;
  lastActive: Date;
}

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

  const tier2 =
    successRate * TIER2_METRIC_WEIGHTS.successRate +
    diversity * TIER2_METRIC_WEIGHTS.diversity +
    volume * TIER2_METRIC_WEIGHTS.volume +
    age * TIER2_METRIC_WEIGHTS.age;

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

  const aggregates: TierAggregates = { tier1, tier2, tier3: null, tier4: null };

  const daysSinceLastTx = (Date.now() - lastTs) / MS_PER_DAY;
  const decay = recencyDecay(daysSinceLastTx);

  const tiered = calculateTieredScore(aggregates, { decay });

  return {
    address,
    score: tiered.score,
    providerScore: tiered.score,
    consumerScore: null,
    trustTier: tiered.trustTier,
    confidenceBadge: tiered.confidenceBadge,
    metrics: {
      successRate,
      diversity,
      volume,
      age,
      attestation: blendedAttestation,
    },
    tierAggregates: aggregates,
    txCount,
    lastActive: new Date(lastTs),
  };
}

export function calculateScores(
  allTransactions: ScoringTransaction[],
  attestations?: Map<string, number>,
): Map<string, WalletScore> {
  const byWallet = new Map<string, ScoringTransaction[]>();
  for (const tx of allTransactions) {
    const group = byWallet.get(tx.wallet_address) ?? [];
    group.push(tx);
    byWallet.set(tx.wallet_address, group);
  }

  const scores = new Map<string, WalletScore>();
  for (const [address, txs] of byWallet) {
    scores.set(address, calculateScore(txs, attestations?.get(address) ?? 0));
  }

  return scores;
}
