/// <reference types="bun-types" />
/**
 * Reproducible scoring: a score is a pure function of its inputs plus an
 * explicit evaluation time (`asOf`). The same transactions scored "as of" the
 * same instant must give the same result no matter when the scorer runs, so a
 * third party can recompute a published score.
 *
 * Run: bun test src/scoring/as-of.test.ts
 */
import { describe, expect, test, setSystemTime, afterEach } from 'bun:test';
import { calculateScore } from './index';
import { calculateOperatorScore } from './operator';

const DAY = 24 * 60 * 60 * 1000;
const AS_OF = new Date('2026-06-01T00:00:00.000Z');

function tx(daysBeforeAsOf: number) {
  return {
    wallet_address: 'W',
    facilitator: 'FAC',
    counterparty: `P${daysBeforeAsOf % 3}`,
    amount: 2,
    timestamp: new Date(AS_OF.getTime() - daysBeforeAsOf * DAY).toISOString(),
    success: true,
    tx_signature: `W-${daysBeforeAsOf}`,
  };
}

const TXS = [tx(1), tx(10), tx(40), tx(120)];

afterEach(() => setSystemTime());

describe('calculateScore asOf', () => {
  test('same inputs + same asOf → identical score regardless of wall clock', () => {
    setSystemTime(new Date('2026-06-02T00:00:00.000Z'));
    const early = calculateScore(TXS, 0, undefined, undefined, null, null, null, null, null, { asOf: AS_OF });
    setSystemTime(new Date('2027-06-02T00:00:00.000Z'));
    const late = calculateScore(TXS, 0, undefined, undefined, null, null, null, null, null, { asOf: AS_OF });
    expect(late).toEqual(early);
  });

  test('asOf actually drives age + recency (not ignored)', () => {
    const fresh = calculateScore(TXS, 0, undefined, undefined, null, null, null, null, null, { asOf: AS_OF });
    const stale = calculateScore(TXS, 0, undefined, undefined, null, null, null, null, null, {
      asOf: new Date(AS_OF.getTime() + 400 * DAY),
    });
    expect(stale.metrics.age).toBeGreaterThan(fresh.metrics.age);
    expect(stale.score).not.toBe(fresh.score);
  });

  test('omitting asOf keeps today’s behavior (scores as of now)', () => {
    setSystemTime(AS_OF);
    const implicit = calculateScore(TXS);
    const explicit = calculateScore(TXS, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { asOf: AS_OF });
    expect(implicit).toEqual(explicit);
  });
});

describe('calculateOperatorScore asOf', () => {
  test('recency is evaluated at asOf, not the wall clock', () => {
    const lastSeen = new Date(AS_OF.getTime() - 2 * DAY);
    setSystemTime(new Date(AS_OF.getTime() + 365 * DAY));
    const r = calculateOperatorScore({ receiptCount: 10, uniquePayerCount: 5, lastSeen, asOf: AS_OF });
    setSystemTime(AS_OF);
    const baseline = calculateOperatorScore({ receiptCount: 10, uniquePayerCount: 5, lastSeen });
    expect(r).toEqual(baseline);
  });
});
