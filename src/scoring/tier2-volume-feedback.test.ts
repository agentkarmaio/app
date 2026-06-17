/// <reference types="bun-types" />
/**
 * Tier-2 scoring fixes (gaps verified against rushikeshmore/agent-karma):
 *
 *   Fix A — avg-deal-size volume. The legacy `volume` metric was actually
 *   transaction COUNT (`cap(txCount, 500)`); USDC `amount` never entered the
 *   score. We now split Tier-2 into `activity` (count) + `avgDealSize` (log $),
 *   and retain `volume` as a blended composite for back-compat.
 *
 *   Fix B — feedback sample-size shrinkage. Local feedback was taken at full
 *   strength once count > 0, so one rating swung the 0.60-weighted Tier-1 term
 *   as hard as fifty. We now shrink toward a neutral 0.5 prior by
 *   confidence = min(1, feedbackCount / 10).
 */

import { describe, expect, test } from 'bun:test';
import { calculateScore } from './index';

const DAY = 24 * 60 * 60 * 1000;

/** Deterministic tx set. Only `amount` varies across the deal-size tests; every
 *  other dimension (count, facilitators, timestamps) is held identical so score
 *  deltas isolate the signal under test. */
function txs(opts: { n?: number; amount?: number; facilitators?: number; addr?: string } = {}) {
  const { n = 50, amount = 1, facilitators = 5, addr = 'W' } = opts;
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    wallet_address: addr,
    facilitator: `FAC_${i % facilitators}`,
    amount,
    timestamp: new Date(now - (i % 30) * DAY - i * 60_000).toISOString(),
    success: true,
    tx_signature: `s-${i}`,
  }));
}

describe('Fix A — avg-deal-size volume', () => {
  test('USDC deal size now moves the provider score (was previously ignored)', () => {
    const small = calculateScore(txs({ amount: 1 }));
    const large = calculateScore(txs({ amount: 500 }));
    // Same count / facilitators / timestamps — only the dollar size differs.
    expect(large.providerScore).toBeGreaterThan(small.providerScore);
    expect(large.metrics.avgDealSize).toBeGreaterThan(small.metrics.avgDealSize);
  });

  test('avgDealSize is log-scaled, monotonic, and clamped to [0,1]', () => {
    const a = calculateScore(txs({ amount: 1 })).metrics.avgDealSize;
    const b = calculateScore(txs({ amount: 50 })).metrics.avgDealSize;
    const c = calculateScore(txs({ amount: 100_000 })).metrics.avgDealSize;
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(c).toBeLessThanOrEqual(1);
    expect(a).toBeGreaterThanOrEqual(0);
  });

  test('activity metric preserves the legacy txCount-based value', () => {
    const m = calculateScore(txs({ n: 5, amount: 1 })).metrics;
    // cap(5, 500) === 0.01 — the value the old `volume` field used to hold.
    expect(m.activity).toBeCloseTo(0.01, 5);
  });

  test('blended volume is retained for back-compat (mean of activity + avgDealSize, in [0,1])', () => {
    const m = calculateScore(txs({ n: 50, amount: 25 })).metrics;
    expect(m.volume).toBeCloseTo(0.5 * (m.activity + m.avgDealSize), 6);
    expect(m.volume).toBeGreaterThanOrEqual(0);
    expect(m.volume).toBeLessThanOrEqual(1);
  });

  test('consumer face also exposes the split + blended volume', () => {
    const cf = calculateScore(txs({ amount: 25 })).consumerFace!;
    expect(cf.metrics.activity).toBeGreaterThan(0);
    expect(cf.metrics.avgDealSize).toBeGreaterThan(0);
    expect(cf.metrics.volume).toBeCloseTo(0.5 * (cf.metrics.activity + cf.metrics.avgDealSize), 6);
  });
});

describe('Fix B — feedback sample-size shrinkage', () => {
  // attestation=0, so Tier-1 == local feedback term; provider score tracks it.
  test('sparse positive feedback is shrunk toward neutral (1 rating < 20 ratings)', () => {
    const one = calculateScore(txs(), 0, 1.0, 1);
    const many = calculateScore(txs(), 0, 1.0, 20);
    expect(many.providerScore).toBeGreaterThan(one.providerScore);
  });

  test('sparse negative feedback is shrunk UP toward neutral (1 fail > 20 fails)', () => {
    const oneFail = calculateScore(txs(), 0, 0.0, 1);
    const manyFail = calculateScore(txs(), 0, 0.0, 20);
    expect(oneFail.providerScore).toBeGreaterThan(manyFail.providerScore);
  });

  test('at/above full-confidence N the raw rate is used unchanged (count 10 ≡ count 100)', () => {
    const ten = calculateScore(txs(), 0, 1.0, 10);
    const hundred = calculateScore(txs(), 0, 1.0, 100);
    expect(ten.providerScore).toBe(hundred.providerScore);
  });

  test('no feedback leaves the score unaffected (regression guard)', () => {
    const none = calculateScore(txs(), 0, undefined, undefined);
    const zeroCount = calculateScore(txs(), 0, 1.0, 0);
    // feedbackCount 0 must NOT engage the local feedback term.
    expect(zeroCount.providerScore).toBe(none.providerScore);
  });
});
