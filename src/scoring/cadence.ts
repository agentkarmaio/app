/**
 * Cadence analysis — derives an automation likelihood score from a wallet's
 * transaction timestamps. Used as a Tier 2 behavioral signal.
 *
 * A wallet with many transactions spread evenly across all 24 UTC hours, at
 * near-constant inter-tx intervals, is almost certainly automated. A wallet
 * that only transacts during a specific time window at irregular intervals
 * looks human-shaped. Both are legitimate — this is a descriptive signal, not
 * a penalty.
 *
 *   automationScore = 0.5 * uniformity + 0.5 * regularity
 *     uniformity  = normalized entropy of the 24-hour UTC histogram
 *     regularity  = 1 − coefficient-of-variation of inter-tx intervals
 *
 * Returns null when there aren't enough transactions to classify reliably.
 */

export const MIN_TX_FOR_CADENCE = 10;

export interface CadenceResult {
  /** [0,1]. Higher = more bot-like. */
  automationScore: number;
  /** Normalized entropy of the 24-bucket UTC-hour histogram. */
  uniformity: number;
  /** 1 − CV of inter-tx intervals, clamped to [0,1]. */
  regularity: number;
  /** 24 integers: tx count per UTC hour. */
  histogram: number[];
  /** tx count used for the computation. */
  txCount: number;
}

export function computeCadence(
  timestamps: Array<string | Date>,
): CadenceResult | null {
  if (timestamps.length < MIN_TX_FOR_CADENCE) return null;

  const sorted = timestamps
    .map((t) => (typeof t === 'string' ? new Date(t) : t).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  if (sorted.length < MIN_TX_FOR_CADENCE) return null;

  const histogram = new Array<number>(24).fill(0);
  for (const t of sorted) histogram[new Date(t).getUTCHours()]++;

  // Uniformity: normalized entropy. 0 = all txs in one hour, 1 = perfectly uniform.
  const n = sorted.length;
  let entropy = 0;
  for (const c of histogram) {
    if (c === 0) continue;
    const p = c / n;
    entropy -= p * Math.log(p);
  }
  const uniformity = entropy / Math.log(24);

  // Regularity: inverted coefficient of variation of inter-tx intervals.
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) intervals.push(sorted[i] - sorted[i - 1]);
  const mean = intervals.reduce((s, x) => s + x, 0) / intervals.length;
  const variance = intervals.reduce((s, x) => s + (x - mean) ** 2, 0) / intervals.length;
  const stddev = Math.sqrt(variance);
  const cv = mean > 0 ? stddev / mean : 1;
  const regularity = Math.max(0, Math.min(1, 1 - cv));

  const automationScore = 0.5 * uniformity + 0.5 * regularity;

  return {
    automationScore,
    uniformity,
    regularity,
    histogram,
    txCount: n,
  };
}
