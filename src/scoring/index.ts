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

import type { ConfidenceBadge, SignalTier, SignalEvent } from '@/db/schema';
import { SIGNAL_KINDS, PRESENCE_ONLY_KINDS } from './signals';

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

/** Log-scaled normalization to [0,1]: log10(1+value)/log10(1+max), clamped.
 *  Diminishing-returns curve — rewards larger values without letting whales
 *  dominate. Mirrors the bonding amountFactor scaling in signals.ts. */
function logCap(value: number, max: number): number {
  return clamp01(Math.log10(1 + Math.max(0, value)) / Math.log10(1 + max));
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
  /**
   * CEILING DISCIPLINE (docs/BONDING-AND-SUCCESSION-DESIGN.md §4.3): when the
   * ONLY Tier-1 (or Tier-presence) evidence is "borrowed" — a bond posted by
   * third parties or a declared/executed will — the receipt axis MUST NOT lift
   * the trust-tier ceiling. A bond/will raises the confidence BADGE + tier
   * PRESENCE only; the ceiling stays governed by behavioral thickness. A
   * thin-file agent must never reach "Excellent" on borrowed capital alone.
   *
   * When true, the receipt-strength axis is collapsed to "none" UNLESS the
   * wallet also has earned (non-borrowed) Tier-1 receipts.
   */
  borrowedTier1Only?: boolean;
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
  // Cardinal discipline: borrowed Tier-1 (bond / will presence) does NOT count
  // toward the receipt axis that lifts the ceiling. It only raised the badge +
  // tier presence elsewhere; here it collapses to "none" so a thin-file agent
  // with a flashy bond/will cannot climb the ceiling on borrowed capital.
  const receiptLevel = evidence.borrowedTier1Only
    ? 0
    : evidence.tier1Strong ? 2 : evidence.hasTier1Receipts ? 1 : 0;
  const ceiling = EVIDENCE_CEILING[behaviorLevel][receiptLevel];

  return tierMin(numeric, ceiling);
}

// ─── Tier blend + confidence badge ────────────────────────────────────────────

/**
 * Confidence badge from tier presence (CLAUDE.md invariant #4).
 *
 *   🟢 receipt-backed     — REQUIRES Tier-1 presence (receipt-gated evidence)
 *   🟡 behavior-inferred  — REQUIRES Tier-2 presence (behavioral evidence)
 *   ⚪ declared           — everything else, incl. a Tier-3-ONLY wallet
 *
 * CARDINAL: a Tier-3-only wallet (e.g. its only signal is a `will_declared`
 * declared-intent row, or a declared manifest) MUST stay ⚪ 'declared'. Tier-3 is
 * declared identity — it is NOT behavioral evidence, so it can never lift the
 * badge to 🟡 on its own. Likewise 🟡 needs real Tier-2 behavior, and 🟢 needs a
 * Tier-1 receipt. This is the per-step guarantee behind the end-to-end badge tests.
 */
export function getConfidenceBadge(aggregates: TierAggregates): ConfidenceBadge {
  const has = (v: number | null | undefined) => typeof v === 'number' && v >= 0;
  if (has(aggregates.tier1)) return 'receipt-backed';
  if (has(aggregates.tier2)) return 'behavior-inferred';
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
    /** Transaction-count contribution (the legacy `volume`, now its own signal). */
    activity: number;
    /** Avg USDC deal size, log-scaled to [0,1] — the dollar dimension. */
    avgDealSize: number;
    /** Back-compat composite: mean of activity + avgDealSize. Not used in the
     *  score (activity + avgDealSize are scored separately); retained so existing
     *  metrics readers + the `scores.volume` column keep working unchanged. */
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
    activity: number;
    avgDealSize: number;
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
  activity:    0.15, // split from the old volume 0.30
  avgDealSize: 0.15, // split from the old volume 0.30
  age:         0.15,
  // +10% cadence blend (same behavior as provider face)
} as const;

const NORMALIZE = {
  diversityMax: 10,
  activityMax: 500,
  /** USDC saturation point for avg-deal-size log scaling. Matches the existing
   *  per-tx amount/1000 normalization convention; tunable here in one place. */
  dealSizeUsdcCap: 1000,
  ageMax: 180,
} as const;

const TIER2_METRIC_WEIGHTS = {
  successRate: 0.35,
  diversity: 0.25,
  activity: 0.10,    // split from the old volume 0.20
  avgDealSize: 0.10, // split from the old volume 0.20
  age: 0.20,
} as const;

/** Feedback shrinkage: the local delivery rate is blended toward a neutral prior
 *  until enough samples accrue, so a single rating cannot swing the 0.60-weighted
 *  Tier-1 term. confidence = min(1, feedbackCount / N). */
const FEEDBACK_NEUTRAL_PRIOR = 0.5;
const FEEDBACK_FULL_CONFIDENCE_N = 10;

/**
 * Optional pay.sh-routed Tier 1 contribution.
 *
 * Per docs/SIGNAL-ARCHITECTURE.md §"pay.sh and operator-attested settlement",
 * the operator's fee-payer signature on a multi-split settlement is itself
 * an implicit, non-repudiable delivery attestation — Tier 1.
 *
 * Score blend rule: pay.sh-routed contribution is `max(existing_tier1, paysh)`
 * (NOT a sum). One Tier 1 signal per tx, never two — a wallet that has BOTH
 * an 8004 attestation and pay.sh-routed receipts cannot exceed `1.0` here, so
 * the wallet is not double-credited against vanilla x402-with-feedback.
 *
 * Strength curve: a single high-confidence pay.sh receipt is already a
 * max-strength Tier 1 signal (the operator broadcast IS the attestation), so
 * we ramp to 1.0 within just a few receipts. Reasoning: unlike behavioral
 * Tier 2 where many txs build evidence, every pay.sh tx *is* an attestation.
 */
function payshTier1Strength(receiptCount: number): number {
  if (receiptCount <= 0) return 0;
  if (receiptCount >= 3) return 1.0;
  // 1 → 0.85, 2 → 0.95
  if (receiptCount === 1) return 0.85;
  return 0.95;
}

// ─── Signal-event aggregation (bonds / heartbeat / will) ────────────────────────
//
// Folds the new `signal_events` rows (bond_opened/bond_resolved, heartbeat_*,
// will_declared) into the four-tier score. This is the wiring that was missing:
// calculateScore never read signalEventsTable, so bonds/heartbeats/wills had no
// effect on any score.
//
// CEILING DISCIPLINE (end-to-end): bond/will signals are in PRESENCE_ONLY_KINDS.
// They contribute a Tier-1 PRESENCE value (so the badge can go 🟢 and the tier
// is "present") but set `borrowedTier1Only` UNLESS the wallet ALSO has an earned
// Tier-1 receipt (8004 / feedback / pay.sh / settlement). evidenceGatedTier then
// collapses the borrowed receipt axis to "none", so a thin-file agent cannot
// climb the trust-tier ceiling on a bond or a will.
//
// is_demo signals are EXCLUDED entirely — they never touch a real score.

export interface SignalAggregate {
  /** Tier-1 presence value from bonds (max of bond_opened/bond_resolved values),
   *  or null when the wallet has no bond signal. Presence-only by discipline. */
  bondTier1: number | null;
  /** Tier-2 durability delta from heartbeats, in [-1, +1] terms already folded
   *  into a bounded value, or null when no heartbeat signal is present. */
  heartbeatTier2: number | null;
  /** Tier-3 presence value from will_declared, or null. Declared intent only —
   *  never lifts the confidence badge (Tier-3 stays ⚪ alone). */
  willTier3: number | null;
  /** True when the ONLY presence-only Tier-1 evidence is borrowed (bond/will/etc)
   *  AND there is no earned Tier-1 receipt. Drives evidenceGatedTier's ceiling
   *  collapse. Meaningless when bondTier1 is null. */
  borrowedTier1Only: boolean;
  /** True when at least one heartbeat_lapsed signal is present (for display). */
  heartbeatLapsed: boolean;
}

/** Heartbeat folds into a SMALL bounded band so it can never dominate Tier 2 or
 *  zero it. Observed adds up to +HEARTBEAT_BAND; a lapse subtracts up to the same.
 *  The existing 0.25 four-tier weight cap on Tier 2 bounds the score impact further. */
const HEARTBEAT_BAND = 0.25;

/**
 * Aggregate raw signal_events into bond/heartbeat/will contributions. Pure.
 *
 * @param events       raw rows for ONE wallet (provider face is what we fold)
 * @param hasEarnedTier1 true when the wallet has a non-borrowed Tier-1 receipt
 *                       (8004 attestation, local feedback, pay.sh, settlement) —
 *                       computed by the caller from the legacy tier1 path. When
 *                       true, a bond/will is NOT the only Tier-1 evidence, so the
 *                       borrowed flag stays false.
 */
export function aggregateSignalEvents(
  events: Pick<SignalEvent, 'kind' | 'tier' | 'face' | 'value' | 'payload'>[],
  hasEarnedTier1: boolean,
): SignalAggregate {
  const isDemo = (p: SignalEvent['payload']): boolean =>
    !!p && typeof p === 'object' && (p as { is_demo?: unknown }).is_demo === true;

  // Real (non-demo) provider-face rows only. is_demo is EXCLUDED from real scores.
  const real = events.filter((e) => e.face === 'provider' && !isDemo(e.payload));

  let bondTier1: number | null = null;
  let willTier3: number | null = null;
  let heartbeatObserved: number | null = null;
  let heartbeatHaircut: number | null = null;
  let heartbeatLapsed = false;
  let sawBorrowedTier1 = false;

  for (const e of real) {
    const v = e.value != null ? clamp01(Number(e.value)) : 0;
    switch (e.kind) {
      case SIGNAL_KINDS.BOND_OPENED:
      case SIGNAL_KINDS.BOND_RESOLVED:
        // Presence-only Tier-1: take the strongest bond value seen.
        bondTier1 = bondTier1 == null ? v : Math.max(bondTier1, v);
        if (PRESENCE_ONLY_KINDS.has(e.kind)) sawBorrowedTier1 = true;
        break;
      case SIGNAL_KINDS.WILL_DECLARED:
        willTier3 = willTier3 == null ? v : Math.max(willTier3, v);
        break;
      case SIGNAL_KINDS.HEARTBEAT_OBSERVED:
        heartbeatObserved = heartbeatObserved == null ? v : Math.max(heartbeatObserved, v);
        break;
      case SIGNAL_KINDS.HEARTBEAT_LAPSED:
        // value carries the (positive) haircut magnitude.
        heartbeatHaircut = heartbeatHaircut == null ? v : Math.max(heartbeatHaircut, v);
        heartbeatLapsed = true;
        break;
      default:
        break;
    }
  }

  // Heartbeat → bounded Tier-2 contribution centered at 0. Observed lifts toward
  // +BAND; a lapse subtracts toward -BAND but is bounded (never zeroes Tier 2,
  // which is enforced again downstream by blending, not replacing).
  let heartbeatTier2: number | null = null;
  if (heartbeatObserved != null || heartbeatHaircut != null) {
    const up = (heartbeatObserved ?? 0) * HEARTBEAT_BAND;
    const down = (heartbeatHaircut ?? 0) * HEARTBEAT_BAND;
    heartbeatTier2 = up - down; // in [-BAND, +BAND]
  }

  return {
    bondTier1,
    heartbeatTier2,
    willTier3,
    // Borrowed ONLY when the bond/will is the sole Tier-1 evidence — i.e. there
    // is no earned Tier-1 receipt. If the wallet earned Tier-1 elsewhere, the
    // bond didn't BECOME the ceiling-lifting evidence, so borrowed stays false.
    borrowedTier1Only: sawBorrowedTier1 && !hasEarnedTier1,
    heartbeatLapsed,
  };
}

export function calculateScore(
  transactions: ScoringTransaction[],
  attestation = 0,
  feedbackDeliveryRate?: number,
  feedbackCount?: number,
  cadenceScore?: number | null,
  manifestScore?: number | null,
  payshRoutedCount?: number | null,
  signalEvents?: Pick<SignalEvent, 'kind' | 'tier' | 'face' | 'value' | 'payload'>[] | null,
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

  // Tier-2 volume is split into two distinct signals: activity (how OFTEN) and
  // avgDealSize (how LARGE). `activity` is the legacy `volume` value (txCount/500).
  // `avgDealSize` log-scales the mean USDC per transaction — the dollar dimension
  // the score previously ignored entirely. `volume` is retained as a blended
  // composite purely for back-compat display + the `scores.volume` column.
  const activity = cap(txCount, NORMALIZE.activityMax);
  const totalUsdc = transactions.reduce((sum, tx) => sum + Number(tx.amount), 0);
  const avgDealSizeUsdc = totalUsdc / txCount; // txCount > 0 guaranteed above
  const avgDealSize = logCap(avgDealSizeUsdc, NORMALIZE.dealSizeUsdcCap);
  const volume = 0.5 * activity + 0.5 * avgDealSize;

  const timestamps = transactions.map((tx) => new Date(tx.timestamp).getTime());
  const firstTs = Math.min(...timestamps);
  const lastTs = Math.max(...timestamps);
  const daysActive = (Date.now() - firstTs) / MS_PER_DAY;
  const age = cap(daysActive, NORMALIZE.ageMax);

  const legacyTier2 =
    successRate * TIER2_METRIC_WEIGHTS.successRate +
    diversity * TIER2_METRIC_WEIGHTS.diversity +
    activity * TIER2_METRIC_WEIGHTS.activity +
    avgDealSize * TIER2_METRIC_WEIGHTS.avgDealSize +
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
    // Sample-size shrinkage: blend the raw delivery rate toward a neutral prior
    // until feedbackCount reaches N, so one rating can't swing the Tier-1 term
    // as hard as fifty. confidence = min(1, feedbackCount / N).
    const rawLocal = clamp01(feedbackDeliveryRate as number);
    const confidence = Math.min(1, (feedbackCount as number) / FEEDBACK_FULL_CONFIDENCE_N);
    const local = confidence * rawLocal + (1 - confidence) * FEEDBACK_NEUTRAL_PRIOR;
    blendedAttestation = onChain * 0.4 + local * 0.6;
    tier1 = blendedAttestation;
  } else if (onChain > 0) {
    blendedAttestation = onChain;
    tier1 = onChain;
  }

  // pay.sh-routed Tier 1 contribution (sprint A1). Combine via `max` against
  // existing 8004 + feedback Tier 1 — never sum, never double-count.
  const payshCount = typeof payshRoutedCount === 'number' && payshRoutedCount > 0
    ? payshRoutedCount
    : 0;
  if (payshCount > 0) {
    const payshStrength = payshTier1Strength(payshCount);
    if (tier1 == null || payshStrength > tier1) {
      tier1 = payshStrength;
    }
    // Surface in the displayed `attestation` metric too, capped by 1.0,
    // so /api/v2 clients see a non-zero attestation even when the wallet
    // has no on-chain 8004 / local feedback.
    if (payshStrength > blendedAttestation) {
      blendedAttestation = payshStrength;
    }
  }

  // Earned Tier-1 = the receipt-gated path above (8004 / feedback / pay.sh).
  // Bonds/wills are "borrowed" and must NOT count as earned for ceiling purposes.
  const hasEarnedTier1 = tier1 != null && tier1 > 0;

  // Fold the new signal_events (bonds / heartbeat / will). is_demo excluded.
  const sig = aggregateSignalEvents(signalEvents ?? [], hasEarnedTier1);

  // Bond presence lifts Tier-1 PRESENCE (so the badge can go 🟢) — combine via
  // max against earned Tier-1, never sum (one Tier-1 aggregate per wallet).
  if (sig.bondTier1 != null) {
    tier1 = tier1 == null ? sig.bondTier1 : Math.max(tier1, sig.bondTier1);
  }

  // Heartbeat → bounded Tier-2 blend. Added to behavioral Tier 2, then clamped
  // to [0,1]; the band (±0.25) plus the four-tier 0.25 weight cap means a lapse
  // can dent but never zero the score, and an observed heartbeat can only nudge.
  let tier2WithHeartbeat = tier2;
  if (sig.heartbeatTier2 != null) {
    tier2WithHeartbeat = clamp01(tier2 + sig.heartbeatTier2);
  }

  // will_declared → Tier-3 presence. Combine with manifest Tier-3 via max. It is
  // declared intent only — the badge logic keeps a Tier-3-only wallet ⚪.
  const manifestTier3 = typeof manifestScore === 'number' ? clamp01(manifestScore) : null;
  const tier3 = sig.willTier3 != null
    ? (manifestTier3 == null ? sig.willTier3 : Math.max(manifestTier3, sig.willTier3))
    : manifestTier3;

  const aggregates: TierAggregates = { tier1, tier2: tier2WithHeartbeat, tier3, tier4: null };

  const daysSinceLastTx = (Date.now() - lastTs) / MS_PER_DAY;
  const decay = recencyDecay(daysSinceLastTx);

  const tiered = calculateTieredScore(aggregates, { decay });

  // Evidence-gated tier progression. See evidenceGatedTier() for rationale —
  // numeric score is the floor, behavioral thickness + receipt strength set
  // the ceiling. Thin-file wallets can't reach Very Good on Tier 2 alone.
  //
  // CEILING DISCIPLINE: borrowedTier1Only comes from the signal aggregator — a
  // bond/will-only Tier-1 collapses the receipt axis to "none", so a thin-file
  // agent cannot reach a high tier on borrowed capital. End-to-end enforcement.
  const providerEvidence: TierEvidence = {
    txCount,
    counterparties: uniqueFacilitators,
    daysActive,
    hasTier1Receipts: tier1 != null && tier1 > 0,
    tier1Strong: tier1 != null && tier1 >= 0.7,
    borrowedTier1Only: sig.borrowedTier1Only,
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
    activity    * CONSUMER_TIER2_METRIC_WEIGHTS.activity +
    avgDealSize * CONSUMER_TIER2_METRIC_WEIGHTS.avgDealSize +
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
    metrics: { successRate, diversity, activity, avgDealSize, volume, age, cadence: cadenceClamped },
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
      activity,
      avgDealSize,
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
  payshRoutedCounts?: Map<string, number>,
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
        payshRoutedCounts?.get(address) ?? null,
      ),
    );
  }

  return scores;
}
