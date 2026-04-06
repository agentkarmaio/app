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
export function calculateScore(transactions: ScoringTransaction[]): WalletScore {
  if (transactions.length === 0) {
    throw new Error('calculateScore requires at least one transaction');
  }

  const address = transactions[0].wallet_address;
  const txCount = transactions.length;

  // Success rate
  const successCount = transactions.filter((tx) => tx.success).length;
  const successRate = txCount > 0 ? successCount / txCount : 0;

  // Diversity: unique facilitator addresses
  const uniqueFacilitators = new Set(transactions.map((tx) => tx.facilitator)).size;
  const diversity = cap(uniqueFacilitators, NORMALIZE.diversityMax);

  // Volume: normalized tx count
  const volume = cap(txCount, NORMALIZE.volumeMax);

  // Age: days since first transaction
  const timestamps = transactions.map((tx) => new Date(tx.timestamp).getTime());
  const firstTs = Math.min(...timestamps);
  const lastTs = Math.max(...timestamps);
  const daysActive = (Date.now() - firstTs) / MS_PER_DAY;
  const age = cap(daysActive, NORMALIZE.ageMax);

  // Attestation: reserved, currently 0
  const attestation = 0;

  // Weighted composite score (0–100)
  const rawScore =
    successRate * WEIGHTS.successRate +
    diversity * WEIGHTS.diversity +
    volume * WEIGHTS.volume +
    age * WEIGHTS.age +
    attestation * WEIGHTS.attestation;

  const score = Math.round(rawScore * 100 * 100) / 100; // scale to 0–100, 2dp

  return {
    address,
    score,
    trustTier: getTrustTier(score),
    metrics: {
      successRate,
      diversity,
      volume,
      age,
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
export function calculateScores(
  allTransactions: ScoringTransaction[]
): Map<string, WalletScore> {
  // Group transactions by wallet
  const byWallet = new Map<string, ScoringTransaction[]>();
  for (const tx of allTransactions) {
    const group = byWallet.get(tx.wallet_address) ?? [];
    group.push(tx);
    byWallet.set(tx.wallet_address, group);
  }

  const scores = new Map<string, WalletScore>();
  for (const [address, txs] of byWallet) {
    scores.set(address, calculateScore(txs));
  }

  return scores;
}
