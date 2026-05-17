/// <reference types="bun-types" />
/**
 * Unit tests for calculateOperatorScore — pay.sh operator (provider-side) Karma.
 */

import { describe, expect, test } from 'bun:test';
import { calculateOperatorScore } from './operator';

const TODAY = new Date();

describe('calculateOperatorScore', () => {
  test('zero receipts → Unrated, declared', () => {
    const r = calculateOperatorScore({ receiptCount: 0, uniquePayerCount: 0 });
    expect(r.score).toBe(0);
    expect(r.trustTier).toBe('Unrated');
    expect(r.confidenceBadge).toBe('declared');
  });

  test('single receipt → behavior-inferred (not yet receipt-backed)', () => {
    const r = calculateOperatorScore({
      receiptCount: 1, uniquePayerCount: 1, lastSeen: TODAY,
    });
    expect(r.confidenceBadge).toBe('behavior-inferred');
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(50);
  });

  test('≥3 receipts → receipt-backed badge', () => {
    const r = calculateOperatorScore({
      receiptCount: 3, uniquePayerCount: 3, lastSeen: TODAY,
    });
    expect(r.confidenceBadge).toBe('receipt-backed');
  });

  test('diversity dominates: 100 payers x 10 calls > 1 payer x 1000 calls', () => {
    const diverse = calculateOperatorScore({
      receiptCount: 1000, uniquePayerCount: 100, lastSeen: TODAY,
    });
    const wash = calculateOperatorScore({
      receiptCount: 1000, uniquePayerCount: 1, lastSeen: TODAY,
    });
    expect(diverse.score).toBeGreaterThan(wash.score);
  });

  test('healthy operator (500 payers, 10k receipts, fresh) approaches max', () => {
    const r = calculateOperatorScore({
      receiptCount: 10_000, uniquePayerCount: 500, lastSeen: TODAY,
    });
    expect(r.score).toBeGreaterThan(85);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.trustTier).toBe('Excellent');
  });

  test('recency: 90-day-old operator scores lower than fresh operator with same volume', () => {
    const fresh = calculateOperatorScore({
      receiptCount: 100, uniquePayerCount: 20, lastSeen: TODAY,
    });
    const dormant = calculateOperatorScore({
      receiptCount: 100, uniquePayerCount: 20,
      lastSeen: new Date(TODAY.getTime() - 90 * 86_400_000),
    });
    expect(fresh.score).toBeGreaterThan(dormant.score);
    // recency floor is 0.75x, so dormant should be at least 75% of fresh
    expect(dormant.score).toBeGreaterThanOrEqual(fresh.score * 0.74);
  });

  test('null lastSeen → applies dormant-floor multiplier (0.75)', () => {
    const withDate = calculateOperatorScore({
      receiptCount: 100, uniquePayerCount: 20, lastSeen: TODAY,
    });
    const noDate = calculateOperatorScore({
      receiptCount: 100, uniquePayerCount: 20, lastSeen: null,
    });
    expect(noDate.score).toBeLessThan(withDate.score);
    expect(noDate.score).toBeGreaterThan(0);
  });

  test('uniquePayerCount=0 with receipts → still gets base + volume only', () => {
    // Edge case: receipts recorded but payer payload missing. Should still
    // produce some score (volume-only) rather than 0.
    const r = calculateOperatorScore({
      receiptCount: 100, uniquePayerCount: 0, lastSeen: TODAY,
    });
    expect(r.score).toBeGreaterThan(10); // base + some volume
    expect(r.score).toBeLessThan(50);    // but capped without diversity
  });
});
