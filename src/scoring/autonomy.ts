/**
 * Autonomy Confidence — RFC v0.3 §5.5.
 *
 * Parallel 0–100 score answering "is this counterparty actually an autonomous
 * agent?" Orthogonal to Karma; MUST NOT be blended into it (RFC §5.5).
 *
 * Six signal components per RFC §5.5:
 *   - cadence_regularity    — 24/7 activity + entropy of UTC-hour histogram
 *   - latency_variance      — inverted CV of inter-tx intervals
 *   - concurrent_depth      — fraction of txs within sub-second clusters
 *   - counterparty_breadth  — unique counterparties vs tx count
 *   - memo_determinism      — (not yet indexed) — null, weight redistributed
 *   - compute_efficiency    — (priority fees / CU not indexed) — null
 *
 * Missing components are dropped and their weight is redistributed across the
 * present ones. Returns null when there are fewer than MIN_TX_FOR_AUTONOMY
 * transactions to classify from.
 *
 * Label mapping: ≥55 agent-like · 30–54 mixed · <30 human-like.
 * Thresholds calibrated against the live x402 population: the top-quartile
 * clearly-automated wallets cluster at 50–60 because most components saturate
 * below 1.0 (facilitator universe caps breadth, bursty agents have high CV).
 */

export const MIN_TX_FOR_AUTONOMY = 10;

export type AutonomyLabel = 'agent-like' | 'mixed' | 'human-like';

export interface AutonomyComponents {
  cadence_regularity: number | null;
  latency_variance: number | null;
  concurrent_depth: number | null;
  counterparty_breadth: number | null;
  memo_determinism: number | null;
  compute_efficiency: number | null;
}

export interface AutonomyResult {
  /** 0–100. */
  score: number;
  label: AutonomyLabel;
  components: AutonomyComponents;
  /** Effective (post-redistribution) weights per component, for transparency. */
  effectiveWeights: Record<keyof AutonomyComponents, number>;
  txCount: number;
}

export interface AutonomyInput {
  timestamp: string | Date;
  counterparty?: string | null;
}

const BASE_WEIGHTS: Record<keyof AutonomyComponents, number> = {
  cadence_regularity:   0.30,
  latency_variance:     0.20,
  concurrent_depth:     0.15,
  counterparty_breadth: 0.15,
  memo_determinism:     0.10,
  compute_efficiency:   0.10,
};

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function labelFor(score: number): AutonomyLabel {
  if (score >= 55) return 'agent-like';
  if (score >= 30) return 'mixed';
  return 'human-like';
}

export function computeAutonomy(txs: AutonomyInput[]): AutonomyResult | null {
  if (txs.length < MIN_TX_FOR_AUTONOMY) return null;

  const sorted = txs
    .map((tx) => ({
      t: (typeof tx.timestamp === 'string' ? new Date(tx.timestamp) : tx.timestamp).getTime(),
      cp: tx.counterparty ?? null,
    }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);

  if (sorted.length < MIN_TX_FOR_AUTONOMY) return null;
  const n = sorted.length;

  // ─── cadence_regularity — normalized entropy of 24h UTC histogram ──────────
  const hist = new Array<number>(24).fill(0);
  for (const x of sorted) hist[new Date(x.t).getUTCHours()]++;
  let entropy = 0;
  for (const c of hist) {
    if (c === 0) continue;
    const p = c / n;
    entropy -= p * Math.log(p);
  }
  const cadence_regularity = clamp01(entropy / Math.log(24));

  // ─── latency_variance — RFC §5.5: "low inter-tx latency → more agent-like" ─
  // Implementation note: a bursty agent has HUGE CV (ms bursts + idle gaps), so
  // inverted-CV falsely reads human. We instead reward consistently *short*
  // intervals by mapping the median inter-tx interval onto [0, 1] via a
  // saturating curve (median <= 60s → 1.0, median >= 1h → 0.0). Captures the
  // RFC intent without punishing the correct bimodal burst pattern.
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) intervals.push(sorted[i].t - sorted[i - 1].t);
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)] ?? 0;
  const medianSec = median / 1000;
  const latency_variance = clamp01(1 - (medianSec - 60) / (3600 - 60));

  // ─── concurrent_depth — fraction of txs clustered within ≤15s of another ──
  // Proxy for "concurrent activity within a single block" until slot data is
  // indexed. 15s ≈ several Solana blocks and catches scripted burst patterns
  // without flagging humans typing sequential commands.
  let clustered = 0;
  for (let i = 0; i < sorted.length; i++) {
    const prev = i > 0 ? sorted[i - 1].t : null;
    const next = i < sorted.length - 1 ? sorted[i + 1].t : null;
    const near = (prev != null && sorted[i].t - prev <= 15_000)
              || (next != null && next - sorted[i].t <= 15_000);
    if (near) clustered++;
  }
  const concurrent_depth = clamp01(clustered / n);

  // ─── counterparty_breadth — unique counterparties relative to activity ─────
  // Until recipient extraction lands (Phase G1b), `counterparty` here is the
  // facilitator, of which ~22 exist in the wild. Saturate against 12 — agents
  // that route through 12+ facilitators have demonstrably broad behavior,
  // humans running a single wrapper don't.
  let counterparty_breadth: number | null = null;
  const cps = new Set(sorted.map((x) => x.cp).filter((v): v is string => v != null));
  if (cps.size > 0) {
    counterparty_breadth = clamp01(cps.size / 12);
  }

  // ─── memo_determinism / compute_efficiency — not yet indexed ──────────────
  const memo_determinism: number | null = null;
  const compute_efficiency: number | null = null;

  const components: AutonomyComponents = {
    cadence_regularity,
    latency_variance,
    concurrent_depth,
    counterparty_breadth,
    memo_determinism,
    compute_efficiency,
  };

  // Blend with weight redistribution across present components.
  const presentKeys = (Object.keys(components) as Array<keyof AutonomyComponents>)
    .filter((k) => typeof components[k] === 'number');
  const presentWeightSum = presentKeys.reduce((s, k) => s + BASE_WEIGHTS[k], 0);

  const effectiveWeights: Record<keyof AutonomyComponents, number> = {
    cadence_regularity: 0,
    latency_variance: 0,
    concurrent_depth: 0,
    counterparty_breadth: 0,
    memo_determinism: 0,
    compute_efficiency: 0,
  };

  let raw = 0;
  for (const k of presentKeys) {
    const w = BASE_WEIGHTS[k] / presentWeightSum;
    effectiveWeights[k] = w;
    raw += w * (components[k] as number);
  }

  const score = Math.round(raw * 100 * 100) / 100;

  return {
    score,
    label: labelFor(score),
    components,
    effectiveWeights,
    txCount: n,
  };
}
