/// <reference types="bun-types" />
/**
 * Counterparty-aware Tier-2 signals (follow-up to the avg-deal-size + shrinkage
 * fixes). Verifies the new loyalty signal (repeat-counterparty depth, Sybil-capped),
 * diversity keying off the real counterparty rather than the facilitator, and the
 * graceful fallback to facilitator when the payee is not yet extracted.
 *
 * Scoring-critical → exhaustive. See docs/counterparty-signal-followup.md.
 */

import { describe, expect, test } from 'bun:test';
import { calculateScore } from './index';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Deterministic tx set spread over a fixed 60-day window (so age + recency are
 * comparable across wallets regardless of n). `counterparties` distributes txs
 * round-robin across that many distinct payees; omit it to leave counterparty
 * undefined (exercises the facilitator fallback). `facilitators` defaults to 1.
 */
function mkTxs(opts: {
  n: number;
  counterparties?: number;
  facilitators?: number;
  addr?: string;
  amount?: number;
}) {
  const { n, counterparties, facilitators = 1, addr = 'W', amount = 1 } = opts;
  const now = Date.now();
  const span = 60 * DAY;
  return Array.from({ length: n }, (_, i) => {
    const tx: {
      wallet_address: string; facilitator: string; amount: number;
      timestamp: string; success: boolean; tx_signature: string; counterparty?: string;
    } = {
      wallet_address: addr,
      facilitator: `FAC_${i % facilitators}`,
      amount,
      timestamp: new Date(now - span + (n > 1 ? Math.round((i / (n - 1)) * span) : span)).toISOString(),
      success: true,
      tx_signature: `s-${addr}-${i}`,
    };
    if (counterparties != null) tx.counterparty = `CP_${i % counterparties}`;
    return tx;
  });
}

describe('loyalty — repeat-counterparty depth', () => {
  test('loyalty rises with repeat business and lifts the provider score', () => {
    // Same counterparty COUNT (diversity held equal); only repeat depth varies.
    const low = calculateScore(mkTxs({ n: 6, counterparties: 6, addr: 'LOW' }));   // avgTx=1 → 0
    const high = calculateScore(mkTxs({ n: 30, counterparties: 6, addr: 'HIGH' })); // avgTx=5 → 1
    expect(low.metrics.loyalty).toBeCloseTo(0, 5);
    expect(high.metrics.loyalty).toBeCloseTo(1, 5);
    expect(high.providerScore).toBeGreaterThan(low.providerScore);
  });

  test('Sybil funnel (≥20 tx/counterparty AND <3 counterparties) is capped at 0.40', () => {
    const funnel = calculateScore(mkTxs({ n: 40, counterparties: 2, addr: 'FUNNEL' }));  // avgTx=20, cp=2
    const healthy = calculateScore(mkTxs({ n: 40, counterparties: 5, addr: 'HEALTHY' })); // avgTx=8, cp=5
    expect(funnel.metrics.loyalty).toBeCloseTo(0.40, 5);   // capped despite raw 1.0
    expect(healthy.metrics.loyalty).toBe(1);               // 5 counterparties → not a funnel
    expect(healthy.metrics.loyalty).toBeGreaterThan(funnel.metrics.loyalty);
  });

  test('a single transaction yields zero loyalty (no repeat to measure)', () => {
    const one = calculateScore(mkTxs({ n: 1, counterparties: 1, addr: 'ONE' }));
    expect(one.metrics.loyalty).toBeCloseTo(0, 5);
  });
});

describe('diversity — keyed off the real counterparty, not the facilitator', () => {
  test('same single facilitator, different counterparty breadth → different diversity', () => {
    const narrow = calculateScore(mkTxs({ n: 10, counterparties: 1, facilitators: 1, addr: 'NARROW' }));
    const broad = calculateScore(mkTxs({ n: 10, counterparties: 10, facilitators: 1, addr: 'BROAD' }));
    // Old facilitator-based diversity would be identical (0.1) for both.
    expect(narrow.metrics.diversity).toBeCloseTo(0.1, 5); // 1 counterparty / 10
    expect(broad.metrics.diversity).toBeCloseTo(1, 5);    // 10 / 10 (cap)
    expect(broad.metrics.diversity).toBeGreaterThan(narrow.metrics.diversity);
  });
});

describe('fallback — diversity degrades to facilitator; loyalty gated on real counterparty', () => {
  test('diversity falls back to facilitator breadth when counterparty is absent', () => {
    // No counterparty, 3 facilitators → 3 breadth buckets via the 'f:' fallback.
    const nullCp = calculateScore(mkTxs({ n: 30, facilitators: 3, addr: 'NULLCP' }));
    // Explicit 3 counterparties, single facilitator → 3 'c:' buckets.
    const explicitCp = calculateScore(mkTxs({ n: 30, counterparties: 3, facilitators: 1, addr: 'EXPCP' }));
    expect(nullCp.metrics.diversity).toBeCloseTo(explicitCp.metrics.diversity, 5);
  });

  test('loyalty is absent (0) without real counterparty data, present with it', () => {
    const nullCp = calculateScore(mkTxs({ n: 30, facilitators: 1, addr: 'NULLCP2' }));     // no counterparty
    const explicitCp = calculateScore(mkTxs({ n: 30, counterparties: 3, addr: 'EXPCP2' })); // real counterparties
    expect(nullCp.metrics.loyalty).toBe(0);            // never derived from facilitators
    expect(explicitCp.metrics.loyalty).toBeGreaterThan(0);
  });

  test('a high-volume single-facilitator wallet is NOT Sybil-penalized via fallback', () => {
    // 1 facilitator, 100 tx, no counterparty: a naive facilitator fallback would hit
    // the Sybil cap (avgTx=100, <3 "counterparties"). Gating loyalty on real
    // counterparty data prevents that mis-fire — loyalty is simply absent.
    const heavy = calculateScore(mkTxs({ n: 100, facilitators: 1, addr: 'HEAVY' }));
    expect(heavy.metrics.loyalty).toBe(0);
  });
});
