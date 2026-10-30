/**
 * Payment-cycle / self-dealing detector — which payer→payee edges are value
 * going round in a loop rather than revenue.
 *
 * Built for Celo's native x402 facilitator relayer, where ~83% of settlements
 * (93.5% of value) on 2026-10-29/30 were a closed 5-wallet ring. Those rows sit
 * in the `celo_x402_settlements` quarantine table; only edges this module
 * leaves clean are promoted into `transactions`, the table karma reads.
 *
 * An edge u→v is flagged when:
 *   - `self-payment`   u = v.
 *   - `short-cycle`    v reaches u in ≤ MAX_CYCLE_LENGTH − 1 hops, i.e. the edge
 *                      lies on a directed cycle of length ≤ MAX_CYCLE_LENGTH.
 *   - `oversized-cluster` the edge is internal to a component the short-cycle
 *                      search could not finish within its step budget; stands
 *                      in for `short-cycle` so the detector fails closed.
 *   - `closed-cluster` the edge is internal to a strongly connected component
 *                      whose members' income or spending mostly stays inside
 *                      (closure ≥ CLOSED_CLUSTER_THRESHOLD, by value or by
 *                      count). This is the low-diversity rule; it catches loops
 *                      longer than the short-cycle bound, and one-way inflow
 *                      from outside cannot dilute it below the bar.
 *
 * Both cluster rules require value to come BACK (an SCC). A one-way pair whose
 * payer pays only that payee is concentrated but not self-dealing; without the
 * SCC gate every customer with a single supplier would be quarantined.
 *
 * Wider than `reciprocity.ts` (direct A↔B pairs only, report-only) and
 * `farm-detector.ts` (ERC-8183 settlement samples). Pure and synchronous: the
 * caller aggregates rows into edges. Design: docs/superpowers/specs/
 * 2026-10-30-celo-x402-cycle-detector-design.md (kept out of this repo).
 */

import { isEvmChain } from '@/lib/chain-meta';
import type { Chain } from '@/db/schema';

/** Longest loop the `short-cycle` rule looks for. */
export const MAX_CYCLE_LENGTH = 6;

/** Closure at or above this reads as a closed cluster. Same bar as `reciprocity.CIRCULAR_THRESHOLD`. */
export const CLOSED_CLUSTER_THRESHOLD = 0.7;

/** Payments from one payer to one payee in the window, already aggregated. */
export interface PaymentEdge {
  payer: string;
  payee: string;
  count: number;
  value: number;
}

/**
 * Edge examinations the short-cycle search may spend on one cluster, and in
 * total. The per-wallet BFS is O(V·(V+E)) in a dense cluster, and sub-cent
 * payments make a dense cluster cheap to build, so the work is capped: a
 * cluster its budget cannot finish is flagged `oversized-cluster` instead
 * (fail closed). Clusters are searched smallest first, so a dense cluster can
 * neither starve honest small ones of the shared budget nor exceed its own.
 * Today's flow costs ~25 steps.
 */
export const MAX_SEARCH_STEPS_PER_CLUSTER = 5_000_000;
export const MAX_SEARCH_STEPS_TOTAL = 20_000_000;

export type CycleReason = 'self-payment' | 'short-cycle' | 'oversized-cluster' | 'closed-cluster';

/** A strongly connected component of ≥ 2 wallets: value goes round inside it. */
export interface PaymentCluster {
  /** Normalized addresses, sorted. */
  members: string[];
  /**
   * The largest of internal / members' outbound and internal / members'
   * inbound, each by value and by payment count. Either side being mostly
   * internal is enough: members whose income, or whose spending, is mostly
   * each other. A share with a zero denominator counts as 0.
   */
  closure: number;
  /** Payments on edges internal to the cluster. */
  count: number;
  value: number;
  /** A shortest loop through `members[0]`: m0 → m1 → … → m0. */
  sampleCycle: string[];
}

export interface PaymentCycleReport {
  /** Flagged edges by {@link edgeKey}. Absent = clean. */
  flagged: Map<string, CycleReason[]>;
  /** Largest value first. */
  clusters: PaymentCluster[];
}

/** Same normalization as `reciprocity.ts`: EVM lowercase, everything else case-sensitive. */
function normalizeAddress(address: string, chain: Chain | string): string {
  return isEvmChain(chain as Chain) ? address.toLowerCase() : address;
}

/** Finite and positive, or it does not contribute. */
function usableAmount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Lookup key into {@link PaymentCycleReport.flagged}. */
export function edgeKey(payer: string, payee: string, chain: Chain | string): string {
  return `${normalizeAddress(payer, chain)}>${normalizeAddress(payee, chain)}`;
}

interface Graph {
  names: string[];
  /** Merged edges, indices into `names`. */
  edges: { from: number; to: number; count: number; value: number }[];
  /** Out-neighbours, self-loops excluded (they never help reach another node). */
  out: number[][];
}

function buildGraph(input: ReadonlyArray<PaymentEdge>, chain: Chain | string): Graph {
  const ids = new Map<string, number>();
  const names: string[] = [];
  const id = (address: string) => {
    let i = ids.get(address);
    if (i === undefined) {
      i = names.length;
      ids.set(address, i);
      names.push(address);
    }
    return i;
  };

  const merged = new Map<string, Graph['edges'][number]>();
  for (const row of input) {
    const from = id(normalizeAddress(row.payer, chain));
    const to = id(normalizeAddress(row.payee, chain));
    const key = `${from}>${to}`;
    const edge = merged.get(key) ?? { from, to, count: 0, value: 0 };
    edge.count += row.count;
    edge.value += usableAmount(row.value);
    merged.set(key, edge);
  }

  const edges = [...merged.values()];
  const out = names.map((): number[] => []);
  for (const { from, to } of edges) if (from !== to) out[from].push(to);
  return { names, edges, out };
}

/** Iterative Tarjan: component id per node. Recursion would overflow on a long ring. */
function stronglyConnectedComponents(out: number[][]): number[] {
  const n = out.length;
  const index = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const comp = new Array<number>(n).fill(-1);
  const stack: number[] = [];
  let nextIndex = 0;
  let nextComp = 0;

  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    // Call frames: [node, position in its neighbour list].
    const frames: [number, number][] = [[root, 0]];
    index[root] = low[root] = nextIndex++;
    stack.push(root);
    onStack[root] = true;

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const [v, pos] = frame;
      if (pos < out[v].length) {
        frame[1] += 1;
        const w = out[v][pos];
        if (index[w] === -1) {
          index[w] = low[w] = nextIndex++;
          stack.push(w);
          onStack[w] = true;
          frames.push([w, 0]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], index[w]);
        }
        continue;
      }
      frames.pop();
      if (frames.length > 0) {
        const parent = frames[frames.length - 1][0];
        low[parent] = Math.min(low[parent], low[v]);
      }
      if (low[v] === index[v]) {
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = false;
          comp[w] = nextComp;
        } while (w !== v);
        nextComp += 1;
      }
    }
  }
  return comp;
}

/**
 * A shortest loop start → … → start inside start's component, as the node list
 * from `start` (the closing edge back to it is implied). Only called for a
 * member of a ≥ 2-wallet component, where such a loop always exists, so the
 * BFS always returns before the frontier runs dry.
 */
function shortestLoop(g: Graph, comp: number[], start: number): number[] {
  const parent = new Map<number, number>([[start, -1]]);
  let last = -1; // the node whose edge closes the loop back to `start`
  for (let frontier = [start]; last === -1;) {
    const next: number[] = [];
    for (let i = 0; i < frontier.length && last === -1; i++) {
      const x = frontier[i];
      for (const y of g.out[x]) {
        if (comp[y] !== comp[start] || parent.has(y)) continue;
        parent.set(y, x);
        next.push(y);
      }
      // `start` is in `parent` from the outset, so check the closing edge here.
      if (g.out[x].includes(start)) last = x;
    }
    frontier = next;
  }
  const path: number[] = [];
  for (let p = last; p !== -1; p = parent.get(p)!) path.push(p);
  return path.reverse();
}

/**
 * Every node `from` reaches in 1..maxHops hops inside its own component, or
 * null once `budget.steps` (one per edge examined) runs out.
 */
function reachableWithin(
  g: Graph, comp: number[], from: number, maxHops: number, budget: { steps: number },
): Set<number> | null {
  const seen = new Set<number>();
  let frontier = [from];
  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
    const next: number[] = [];
    for (const x of frontier) {
      for (const y of g.out[x]) {
        if (--budget.steps < 0) return null;
        if (comp[y] !== comp[from] || seen.has(y)) continue;
        seen.add(y);
        next.push(y);
      }
    }
    frontier = next;
  }
  return seen;
}

interface Flow { value: number; count: number }
const emptyFlow = (): Flow => ({ value: 0, count: 0 });
function addFlow(flow: Flow, edge: Flow): void {
  flow.value += edge.value;
  flow.count += edge.count;
}
const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

/** Flag the self-dealing edges in a payer→payee graph and report its loops. */
export function detectPaymentCycles(input: ReadonlyArray<PaymentEdge>, chain: Chain | string): PaymentCycleReport {
  const g = buildGraph(input, chain);
  const comp = stronglyConnectedComponents(g.out);

  const size = new Map<number, number>();
  for (const c of comp) size.set(c, (size.get(c) ?? 0) + 1);
  const inCluster = (node: number) => size.get(comp[node])! >= 2;

  // Per cluster: internal, outbound and inbound flow.
  const tally = new Map<number, { internal: Flow; out: Flow; in: Flow }>();
  const tallyOf = (c: number) => {
    let t = tally.get(c);
    if (!t) tally.set(c, (t = { internal: emptyFlow(), out: emptyFlow(), in: emptyFlow() }));
    return t;
  };
  // Internal non-self edges, by payee: preds[v] = every u with u→v inside v's cluster.
  const preds = g.names.map((): number[] => []);
  for (const edge of g.edges) {
    if (inCluster(edge.from)) addFlow(tallyOf(comp[edge.from]).out, edge);
    if (inCluster(edge.to)) addFlow(tallyOf(comp[edge.to]).in, edge);
    if (inCluster(edge.from) && comp[edge.from] === comp[edge.to]) {
      const t = tallyOf(comp[edge.from]);
      addFlow(t.internal, edge);
      if (edge.from !== edge.to) preds[edge.to].push(edge.from);
    }
  }

  // Value OR count (karma reads both, so a zero-value loop is closed by
  // count), and outbound OR inbound side (so one-way inflow from outside
  // cannot dilute a ring below the bar).
  const closure = new Map<number, number>();
  for (const [c, t] of tally) {
    const by = (k: keyof Flow) => Math.max(share(t.internal[k], t.out[k]), share(t.internal[k], t.in[k]));
    closure.set(c, Math.max(by('value'), by('count')));
  }

  const membersOf = new Map<number, number[]>();
  for (let v = 0; v < comp.length; v++) {
    if (!inCluster(v)) continue;
    const list = membersOf.get(comp[v]) ?? [];
    list.push(v);
    membersOf.set(comp[v], list);
  }

  // u→v lies on a cycle ≤ MAX_CYCLE_LENGTH iff v reaches u in ≤ MAX − 1 hops.
  // One bounded BFS per wallet, shared by all its inbound edges. Smallest
  // clusters first, each on min(its own cap, what is left of the total); a
  // cluster its budget cannot finish is oversized as a whole.
  const internalEdges = (nodes: number[]) => nodes.reduce((sum, v) => sum + preds[v].length, 0);
  const searchOrder = [...membersOf]
    .map(([c, nodes]) => ({ c, nodes, size: internalEdges(nodes) }))
    .sort((a, b) => a.size - b.size || a.nodes[0] - b.nodes[0]);
  const shortCycleEdges = new Set<string>();
  const oversized = new Set<number>();
  let remaining = MAX_SEARCH_STEPS_TOTAL;
  for (const { c, nodes } of searchOrder) {
    const cap = Math.min(MAX_SEARCH_STEPS_PER_CLUSTER, remaining);
    const budget = { steps: cap };
    for (const v of nodes) {
      const reach = reachableWithin(g, comp, v, MAX_CYCLE_LENGTH - 1, budget);
      if (!reach) {
        oversized.add(c);
        break;
      }
      for (const u of preds[v]) if (reach.has(u)) shortCycleEdges.add(`${u}>${v}`);
    }
    remaining -= cap - Math.max(budget.steps, 0);
  }

  const flagged = new Map<string, CycleReason[]>();
  for (const edge of g.edges) {
    const key = `${g.names[edge.from]}>${g.names[edge.to]}`;
    if (edge.from === edge.to) {
      flagged.set(key, ['self-payment']);
      continue;
    }
    const c = comp[edge.from];
    if (c !== comp[edge.to]) continue;
    const reasons: CycleReason[] = [];
    if (oversized.has(c)) reasons.push('oversized-cluster');
    else if (shortCycleEdges.has(`${edge.from}>${edge.to}`)) reasons.push('short-cycle');
    if (closure.get(c)! >= CLOSED_CLUSTER_THRESHOLD) reasons.push('closed-cluster');
    if (reasons.length > 0) flagged.set(key, reasons);
  }

  const clusters: PaymentCluster[] = [...membersOf].map(([c, nodes]) => {
    nodes.sort((a, b) => (g.names[a] < g.names[b] ? -1 : 1));
    const start = nodes[0];
    const loop = shortestLoop(g, comp, start);
    const t = tally.get(c)!;
    return {
      members: nodes.map((v) => g.names[v]),
      closure: closure.get(c)!,
      count: t.internal.count,
      value: t.internal.value,
      sampleCycle: loop.map((v) => g.names[v]),
    };
  });
  clusters.sort((a, b) => b.value - a.value);

  return { flagged, clusters };
}
