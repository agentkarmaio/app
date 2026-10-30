/// <reference types="bun-types" />
/**
 * Payment-cycle / self-dealing detector. Data integrity → exhaustive: this
 * decides which Celo relayer settlements may leave quarantine and reach karma.
 * The failure that matters is a ring row read as clean, so every rule gets a
 * positive case, a just-below-threshold negative, and a "value never comes
 * back" control.
 */

import { describe, expect, test } from 'bun:test';
import {
  detectPaymentCycles,
  edgeKey,
  CLOSED_CLUSTER_THRESHOLD,
  MAX_CYCLE_LENGTH,
  MAX_SEARCH_STEPS_PER_CLUSTER,
  MAX_SEARCH_STEPS_TOTAL,
  type PaymentEdge,
} from './payment-cycles';
import { CELO_RELAYER_EDGES_2026_10_30, CELO_RING } from './payment-cycles.fixture';

const e = (payer: string, payee: string, value = 1, count = 1): PaymentEdge => ({ payer, payee, count, value });

/** n-node directed cycle n0 → n1 → … → n(n-1) → n0. */
function cycle(prefix: string, n: number, value = 1, count = 1): PaymentEdge[] {
  return Array.from({ length: n }, (_, i) => e(`${prefix}${i}`, `${prefix}${(i + 1) % n}`, value, count));
}

const reasons = (r: ReturnType<typeof detectPaymentCycles>, payer: string, payee: string, chain = 'celo') =>
  r.flagged.get(edgeKey(payer, payee, chain)) ?? [];

describe('constants', () => {
  test('match the approved spec', () => {
    expect(MAX_CYCLE_LENGTH).toBe(6);
    expect(CLOSED_CLUSTER_THRESHOLD).toBe(0.7);
    expect(MAX_SEARCH_STEPS_PER_CLUSTER).toBe(5_000_000);
    expect(MAX_SEARCH_STEPS_TOTAL).toBe(20_000_000);
  });
});

describe('golden: Celo relayer flow 2026-10-29/30', () => {
  const report = detectPaymentCycles(CELO_RELAYER_EDGES_2026_10_30, 'celo');

  test('every ring edge is flagged by both rules', () => {
    for (let i = 0; i < CELO_RING.length; i++) {
      const payer = CELO_RING[i];
      const payee = CELO_RING[(i + 1) % CELO_RING.length];
      expect(reasons(report, payer, payee)).toEqual(['short-cycle', 'closed-cluster']);
    }
    expect(report.flagged.size).toBe(5);
  });

  test('all 30 non-ring edges are clean, including one-way pairs and the fan-in hub', () => {
    const ring = new Set<string>(CELO_RING);
    const outside = CELO_RELAYER_EDGES_2026_10_30.filter((x) => !ring.has(x.payer));
    expect(outside).toHaveLength(30);
    for (const x of outside) expect(reasons(report, x.payer, x.payee)).toEqual([]);
  });

  test('reports one closed cluster: the ring, closure 1, 3,592 rows', () => {
    expect(report.clusters).toHaveLength(1);
    const [ring] = report.clusters;
    expect(ring.members).toEqual([...CELO_RING].sort());
    expect(ring.closure).toBe(1);
    expect(ring.count).toBe(3592);
    expect(ring.value).toBeCloseTo(339.08, 2);
    expect(ring.sampleCycle).toHaveLength(5);
    expect(ring.sampleCycle[0]).toBe([...CELO_RING].sort()[0]);
  });
});

describe('short-cycle rule', () => {
  test('a direct A↔B pair is a 2-cycle', () => {
    const r = detectPaymentCycles([e('a', 'b'), e('b', 'a')], 'celo');
    expect(reasons(r, 'a', 'b')).toEqual(['short-cycle', 'closed-cluster']);
    expect(reasons(r, 'b', 'a')).toEqual(['short-cycle', 'closed-cluster']);
    expect(r.clusters[0].sampleCycle).toEqual(['a', 'b']);
  });

  test('a 6-cycle is short, a 7-cycle is not', () => {
    const six = detectPaymentCycles(cycle('s', 6), 'celo');
    for (const x of cycle('s', 6)) expect(reasons(six, x.payer, x.payee)).toEqual(['short-cycle', 'closed-cluster']);

    const seven = detectPaymentCycles(cycle('l', 7), 'celo');
    for (const x of cycle('l', 7)) expect(reasons(seven, x.payer, x.payee)).toEqual(['closed-cluster']);
  });

  test('is per edge: only edges on the short loop get it', () => {
    // 7-cycle l0..l6 plus chord l2 → l0 closes the 3-cycle l0 → l1 → l2 → l0.
    const r = detectPaymentCycles([...cycle('l', 7), e('l2', 'l0')], 'celo');
    expect(reasons(r, 'l0', 'l1')).toContain('short-cycle');
    expect(reasons(r, 'l1', 'l2')).toContain('short-cycle');
    expect(reasons(r, 'l2', 'l0')).toContain('short-cycle');
    expect(reasons(r, 'l3', 'l4')).toEqual(['closed-cluster']);
    expect(r.clusters[0].sampleCycle).toEqual(['l0', 'l1', 'l2']);
  });

  test('flags a short loop inside an open economy, but not the open edges', () => {
    // Hub h trades mostly with outsiders; a↔h is the only loop.
    const r = detectPaymentCycles(
      [e('a', 'h', 1), e('h', 'a', 1), e('h', 'x', 50), e('y', 'h', 50)],
      'celo',
    );
    expect(reasons(r, 'a', 'h')).toEqual(['short-cycle']);
    expect(reasons(r, 'h', 'a')).toEqual(['short-cycle']);
    expect(reasons(r, 'h', 'x')).toEqual([]);
    expect(reasons(r, 'y', 'h')).toEqual([]);
    // by value 2/52, by count 2/3 → the larger
    expect(r.clusters[0].closure).toBeCloseTo(2 / 3, 10);
  });
});

describe('closed-cluster (low-diversity) rule', () => {
  /** 7-cycle of value 6 per edge, with `leak` paid out and `inflow` paid in per member. */
  const leaky = (leak: number, inflow: number, count = 1) => [
    ...cycle('l', 7, 6),
    ...Array.from({ length: 7 }, (_, i) => e(`l${i}`, `out${i}`, leak, count)),
    ...Array.from({ length: 7 }, (_, i) => e(`in${i}`, `l${i}`, inflow, count)),
  ];

  test('leaking 40% of spending but earning only from each other is flagged', () => {
    const r = detectPaymentCycles(leaky(4, 0), 'celo');
    expect(r.clusters[0].closure).toBe(1);
    expect(reasons(r, 'l0', 'l1')).toEqual(['closed-cluster']);
    expect(reasons(r, 'l0', 'out0')).toEqual([]);
  });

  test('one-way inflow from outside cannot dilute a ring that spends only on itself', () => {
    const r = detectPaymentCycles(leaky(0, 40), 'celo');
    expect(r.clusters[0].closure).toBe(1);
    expect(reasons(r, 'l0', 'l1')).toEqual(['closed-cluster']);
    expect(reasons(r, 'in0', 'l0')).toEqual([]);
  });

  test('a loop with 40% outside flow on both sides is an open economy: clean', () => {
    const r = detectPaymentCycles(leaky(4, 4, 2), 'celo');
    // by value 42 / 70 = 0.6; by count 7 / 21 on each side
    expect(r.clusters[0].closure).toBeCloseTo(0.6, 10);
    expect(r.flagged.size).toBe(0);
  });

  test('closure exactly at the threshold is flagged', () => {
    // by value: internal 42 / 60 on both sides; by count: 7 / 28
    const r = detectPaymentCycles([...cycle('l', 7, 6), e('l0', 'out', 18, 21), e('in', 'l0', 18, 21)], 'celo');
    expect(r.clusters[0].closure).toBe(0.7);
    expect(reasons(r, 'l0', 'l1')).toEqual(['closed-cluster']);
    expect(reasons(r, 'l0', 'out')).toEqual([]);
  });

  test('a zero-value loop is still closed by count', () => {
    const r = detectPaymentCycles(cycle('z', 7, 0), 'celo');
    expect(r.clusters[0].closure).toBe(1);
    expect(reasons(r, 'z0', 'z1')).toEqual(['closed-cluster']);
  });

  test('closed by count even when value leaks out', () => {
    // One large payment out and one in carry most of the value; nearly every payment stays inside.
    const r = detectPaymentCycles([...cycle('l', 7, 1, 10), e('l0', 'out', 100), e('in', 'l3', 100)], 'celo');
    expect(r.clusters[0].closure).toBeCloseTo(70 / 71, 10);
    expect(reasons(r, 'l3', 'l4')).toEqual(['closed-cluster']);
  });

  test('zero count and zero value give closure 0', () => {
    const r = detectPaymentCycles([e('a', 'b', 0, 0), e('b', 'a', 0, 0)], 'celo');
    expect(r.clusters[0].closure).toBe(0);
    expect(reasons(r, 'a', 'b')).toEqual(['short-cycle']);
  });
});

describe('value must come back', () => {
  test('one-way pair is clean even though each side is 100% concentrated', () => {
    const r = detectPaymentCycles([e('payer', 'payee', 5, 12)], 'celo');
    expect(r.flagged.size).toBe(0);
    expect(r.clusters).toEqual([]);
  });

  test('fan-in of single-purpose payers is clean', () => {
    const r = detectPaymentCycles(Array.from({ length: 20 }, (_, i) => e(`p${i}`, 'hub', 0.15, 22)), 'celo');
    expect(r.flagged.size).toBe(0);
  });

  test('a DAG chain a → b → c → d is clean', () => {
    const r = detectPaymentCycles([e('a', 'b'), e('b', 'c'), e('c', 'd')], 'celo');
    expect(r.flagged.size).toBe(0);
  });
});

describe('self-payment', () => {
  test('a lone self-payment is flagged and is not a cluster', () => {
    const r = detectPaymentCycles([e('a', 'a')], 'celo');
    expect(reasons(r, 'a', 'a')).toEqual(['self-payment']);
    expect(r.clusters).toEqual([]);
  });

  test('inside a cluster it keeps only its own reason, and its value counts as internal', () => {
    const r = detectPaymentCycles(
      [e('a', 'a', 10), e('a', 'b', 1), e('b', 'a', 1), e('b', 'x', 2), e('y', 'a', 2)],
      'celo',
    );
    expect(reasons(r, 'a', 'a')).toEqual(['self-payment']);
    expect(reasons(r, 'a', 'b')).toEqual(['short-cycle', 'closed-cluster']);
    // by value: internal 12 / 14 on both sides; by count: 3 / 4
    expect(r.clusters[0].closure).toBeCloseTo(12 / 14, 10);
    expect(r.clusters[0].count).toBe(3);
  });
});

describe('address normalization and input hygiene', () => {
  test('EVM chains fold case, so a mixed-case ring is still one ring', () => {
    const r = detectPaymentCycles([e('0xAA', '0xbb'), e('0xBB', '0xaa')], 'celo');
    expect(reasons(r, '0xaa', '0xBB')).toEqual(['short-cycle', 'closed-cluster']);
    expect(edgeKey('0xAA', '0xBB', 'arc-mainnet')).toBe(edgeKey('0xaa', '0xbb', 'arc-mainnet'));
  });

  test('non-EVM chains stay case-sensitive', () => {
    const r = detectPaymentCycles([e('GA', 'gb'), e('GB', 'ga')], 'stellar');
    expect(r.flagged.size).toBe(0);
    expect(edgeKey('GA', 'gb', 'stellar')).not.toBe(edgeKey('ga', 'gb', 'stellar'));
  });

  test('duplicate edges merge into one', () => {
    const r = detectPaymentCycles([e('0xA', '0xb', 1, 2), e('0xa', '0xB', 1, 3), e('0xb', '0xa', 1, 1)], 'celo');
    expect(r.clusters[0].count).toBe(6);
    expect(r.clusters[0].value).toBe(3);
  });

  test('NaN, infinite and negative values contribute nothing', () => {
    const r = detectPaymentCycles(
      [e('a', 'b', 1), e('b', 'a', 1), e('a', 'x', Number.NaN), e('a', 'y', -5), e('a', 'z', Infinity)],
      'celo',
    );
    expect(r.clusters[0].closure).toBe(1);
  });

  test('empty input', () => {
    expect(detectPaymentCycles([], 'celo')).toEqual({ flagged: new Map(), clusters: [] });
  });
});

describe('scale', () => {
  test('a 20,000-wallet ring does not overflow the stack', () => {
    const r = detectPaymentCycles(cycle('w', 20_000), 'celo');
    expect(r.flagged.size).toBe(20_000);
    expect(reasons(r, 'w0', 'w1')).toEqual(['closed-cluster']);
    expect(r.clusters[0].sampleCycle).toHaveLength(20_000);
  });

  /** Complete directed graph on n wallets: every BFS sees ~n² edges, so ~n³ steps in all. */
  const complete = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => j))
      .flatMap((row, i) => row.filter((j) => j !== i).map((j) => e(`${prefix}${i}`, `${prefix}${j}`)));

  test('a cluster within the search budget is searched', () => {
    const r = detectPaymentCycles(complete('k', 100), 'celo');
    expect(reasons(r, 'k0', 'k1')).toEqual(['short-cycle', 'closed-cluster']);
  });

  test('a cluster the budget cannot finish fails closed', () => {
    const r = detectPaymentCycles(complete('k', 200), 'celo');
    expect(reasons(r, 'k0', 'k1')).toEqual(['oversized-cluster', 'closed-cluster']);
    expect(reasons(r, 'k199', 'k0')).toEqual(['oversized-cluster', 'closed-cluster']);
  });

  test('the total budget caps work across many dense clusters; small ones are searched first', () => {
    // Each K_150 costs ~3.4M steps (under its own cap); the 6th would exceed the 20M total.
    const dense = Array.from({ length: 7 }, (_, i) => complete(`d${i}x`, 150)).flat();
    const r = detectPaymentCycles([...dense, e('a', 'b'), e('b', 'a')], 'celo');
    expect(reasons(r, 'a', 'b')).toEqual(['short-cycle', 'closed-cluster']);
    const verdicts = Array.from({ length: 7 }, (_, i) => reasons(r, `d${i}x0`, `d${i}x1`)[0]);
    expect(verdicts.filter((v) => v === 'short-cycle')).toHaveLength(5);
    expect(verdicts.filter((v) => v === 'oversized-cluster')).toHaveLength(2);
  });

  test('a dense cluster cannot spend the budget of honest clusters around it', () => {
    const r = detectPaymentCycles([e('a', 'b'), e('b', 'a'), ...complete('k', 200), e('x', 'y'), e('y', 'x')], 'celo');
    expect(reasons(r, 'k0', 'k1')).toEqual(['oversized-cluster', 'closed-cluster']);
    expect(reasons(r, 'a', 'b')).toEqual(['short-cycle', 'closed-cluster']);
    expect(reasons(r, 'x', 'y')).toEqual(['short-cycle', 'closed-cluster']);
  });

  test('clusters are ordered by value, largest first', () => {
    const r = detectPaymentCycles([e('a', 'b', 1), e('b', 'a', 1), e('c', 'd', 5), e('d', 'c', 5)], 'celo');
    expect(r.clusters.map((c) => c.members)).toEqual([['c', 'd'], ['a', 'b']]);
  });
});
