/**
 * Karma Scoring Engine — Computes trust scores for agent wallets
 * based on their x402 transaction history.
 *
 * Formula (weighted):
 *   score = (successRate × 0.35) + (diversity × 0.25) + (volume × 0.20)
 *         + (age × 0.10) + (attestation × 0.10)
 *   attestation is reserved for future 8004 integration (currently 0)
 *
 * TrustTier thresholds:
 *   0–20   → Unrated
 *   21–40  → Poor
 *   41–60  → Fair
 *   61–75  → Good
 *   76–90  → Very Good
 *   91–100 → Excellent
 */

// Accepts Transaction with timestamp as string or Date
interface ScoringTransaction {
  wallet_address: string;
  facilitator: string;
  amount: number;
  timestamp: string | Date;
  success: boolean;
  tx_signature: string;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type TrustTier = 'Unrated' | 'Poor' | 'Fair' | 'Good' | 'Very Good' | 'Excellent';

export interface WalletScore {
  address: string;
  score: number;       // 0–100 (rounded to 2 decimal places)
  trustTier: TrustTier;
  metrics: {
    successRate: number;  // 0–1
    diversity: number;    // normalized unique facilitator count (0–1)
    volume: number;       // normalized tx count (0–1)
    age: number;          // normalized days since first tx (0–1)
    attestation: number;  // 0–1 from 8004 on-chain feedback
  };
  txCount: number;
  lastActive: Date;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const WEIGHTS = {
  successRate: 0.35,
  diversity: 0.25,
  volume: 0.20,
  age: 0.10,
  attestation: 0.10,
} as const;

const NORMALIZE = {
  diversityMax: 10,   // unique_services / 10 (capped at 1.0)
  volumeMax: 500,     // tx_count / 500 (capped at 1.0)
  ageMax: 180,        // days_active / 180 (capped at 1.0)
} as const;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Recency decay — penalizes agents who haven't transacted recently.
 * Active agents (< 7 days) get no penalty. Dormant/inactive get up to 20% reduction.
 *
 *   0–7 days:   multiplier = 1.0  (no decay)
 *   7–30 days:  multiplier = 1.0 → 0.95  (gentle)
 *   30–90 days: multiplier = 0.95 → 0.85  (moderate)
 *   90+ days:   multiplier = 0.80  (floor)
 */
function recencyDecay(daysSinceLastTx: number): number {
  if (daysSinceLastTx <= 7) return 1.0;
  if (daysSinceLastTx <= 30) return 1.0 - 0.05 * ((daysSinceLastTx - 7) / 23);
  if (daysSinceLastTx <= 90) return 0.95 - 0.10 * ((daysSinceLastTx - 30) / 60);
  return 0.80;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Map a raw 0–100 score to a trust tier label */
export function getTrustTier(score: number): TrustTier {
  if (score <= 20) return 'Unrated';
  if (score <= 40) return 'Poor';
  if (score <= 60) return 'Fair';
  if (score <= 75) return 'Good';
  if (score <= 90) return 'Very Good';
  return 'Excellent';
}

function cap(value: number, max: number): number {
  return Math.min(value / max, 1.0);
}

// ─── Core Scoring ─────────────────────────────────────────────────────────────

/**
 * Calculate a WalletScore for a single wallet given its transactions.
 * All transactions must belong to the same wallet (wallet_address).
 */
/**
 * Calculate a WalletScore for a single wallet given its transactions.
 * @param attestation — 8004 on-chain feedback score (0–1). Fetched externally via readAttestation().
 * @param feedbackDeliveryRate — local consumer feedback delivery rate (0–1). From getFeedbackSummary().
 * @param feedbackCount — number of local feedback submissions for weighting.
 *
 * The attestation metric blends 8004 on-chain score with local feedback:
 *   - If no local feedback: use 8004 score only
 *   - If local feedback exists: weighted average of 8004 (40%) + local delivery rate (60%)
 *   - Local feedback is weighted higher because it's tied to actual transaction references
 */
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

  // Blend 8004 on-chain attestation with local consumer feedback
  let blendedAttestation: number;
  if (feedbackCount && feedbackCount > 0 && feedbackDeliveryRate !== undefined) {
    // Local feedback exists — weighted blend (local gets 60% because it's tx-referenced)
    const localScore = Math.min(Math.max(feedbackDeliveryRate, 0), 1);
    const onChainScore = Math.min(Math.max(attestation, 0), 1);
    blendedAttestation = onChainScore * 0.4 + localScore * 0.6;
  } else {
    blendedAttestation = Math.min(Math.max(attestation, 0), 1);
  }
  const clampedAttestation = blendedAttestation;

  const rawScore =
    successRate * WEIGHTS.successRate +
    diversity * WEIGHTS.diversity +
    volume * WEIGHTS.volume +
    age * WEIGHTS.age +
    clampedAttestation * WEIGHTS.attestation;

  // Apply recency decay — penalizes stale agents
  const daysSinceLastTx = (Date.now() - lastTs) / MS_PER_DAY;
  const decay = recencyDecay(daysSinceLastTx);
  const score = Math.round(rawScore * decay * 100 * 100) / 100;

  return {
    address,
    score,
    trustTier: getTrustTier(score),
    metrics: {
      successRate,
      diversity,
      volume,
      age,
      attestation: clampedAttestation,
    },
    txCount,
    lastActive: new Date(lastTs),
  };
}

/**
 * Calculate scores for all wallets in a mixed transaction list.
 * Groups by wallet_address, then calls calculateScore for each group.
 * Returns a map of address → WalletScore.
 */
/**
 * @param attestations — optional map of wallet → attestation score (0–1)
 */
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
