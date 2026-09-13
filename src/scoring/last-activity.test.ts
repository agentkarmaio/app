/// <reference types="bun-types" />
/**
 * `WalletScore.lastActive` — the observed on-chain timestamp that
 * `wallets.last_seen` is now written from.
 *
 * The value was always computed here and always correct; nothing carried it to
 * the column. `upsertWallet` stamped `new Date()` instead, so `last_seen`
 * recorded OUR indexer cadence: a Solana wallet with 397 transactions read
 * "Dormant" because that was the last time we rescored it, and 309 declared
 * agents with zero transactions read "Inactive" because that was the age of
 * their backfill row. These tests pin the value AND its delivery.
 *
 * Run: bun test src/scoring/last-activity.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { calculateScore, calculateScores } from './index';

const DAY = 24 * 60 * 60 * 1000;

function tx(addr: string, daysAgo: number) {
  return {
    wallet_address: addr,
    facilitator: 'FAC',
    amount: 1,
    timestamp: new Date(Date.now() - daysAgo * DAY).toISOString(),
    success: true,
    tx_signature: `${addr}-${daysAgo}`,
  };
}

describe('calculateScore reports the latest observed timestamp', () => {
  test('lastActive is MAX(tx.timestamp), not the scoring run time', () => {
    const txs = [tx('W', 30), tx('W', 2), tx('W', 90)];
    const newest = txs.map((t) => t.timestamp).sort().at(-1)!;

    const score = calculateScore(txs);

    expect(score.lastActive.toISOString()).toBe(newest);
    // The guard that matters: it must NOT be "now".
    expect(score.lastActive.getTime()).toBeLessThan(Date.now() - DAY);
  });

  test('input order does not change the answer', () => {
    const txs = [tx('W', 2), tx('W', 90), tx('W', 30)];
    expect(calculateScore(txs).lastActive.getTime())
      .toBe(calculateScore([...txs].reverse()).lastActive.getTime());
  });

  test('a single transaction reports its own timestamp', () => {
    const only = tx('W', 5);
    expect(calculateScore([only]).lastActive.toISOString()).toBe(only.timestamp);
  });

  test('calculateScores keeps it per wallet, never crossing addresses', () => {
    const a = tx('A', 1), b = tx('B', 200);
    const scores = calculateScores([a, tx('A', 40), b]);
    expect(scores.get('A')!.lastActive.toISOString()).toBe(a.timestamp);
    expect(scores.get('B')!.lastActive.toISOString()).toBe(b.timestamp);
  });
});
