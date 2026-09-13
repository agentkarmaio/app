/// <reference types="bun-types" />
/**
 * publishTopScores dispatches to the right ChainAdapter and aggregates
 * PublishResults. We inject a fake leaderboard + fake adapter through the
 * test seam — no DB, no chain calls.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { publishTopScores, __setPublishDepsForTest } from './publish';
import type { PublishResult } from '@/chain-adapters/types';

afterEach(() => __setPublishDepsForTest(null));

describe('publishTopScores', () => {
  beforeEach(() => {
    __setPublishDepsForTest({
      getLeaderboard: async () => ({
        wallets: [{ address: 'GWALLET1' }, { address: 'GWALLET2' }], total: 2,
      }),
      getTransactions: async () => [{ tx_signature: 'x' }],
      calculateScore: () => ({ score: 80, trustTier: 'Good' }),
      getAdapter: (chain: string) => ({
        chain,
        async readAttestation() { return 0; },
        async publishAttestation(address: string): Promise<PublishResult> {
          return { address, dryRun: false, skipped: false, txId: 'tx_' + address };
        },
      }),
    });
  });

  test('routes to the chain passed and publishes each wallet', async () => {
    const r = await publishTopScores(2, 'stellar');
    expect(r.published).toBe(2);
    expect(r.details[0].signature).toBe('tx_GWALLET1');
  });

  test('defaults to solana when chain omitted', async () => {
    let seen = '';
    __setPublishDepsForTest({
      getLeaderboard: async () => ({ wallets: [{ address: 'A' }], total: 1 }),
      getTransactions: async () => [{ tx_signature: 'x' }],
      calculateScore: () => ({ score: 80, trustTier: 'Good' }),
      getAdapter: (chain: string) => { seen = chain; return {
        chain, async readAttestation() { return 0; },
        async publishAttestation(address: string): Promise<PublishResult> {
          return { address, dryRun: false, skipped: false };
        },
      }; },
    });
    await publishTopScores(1);
    expect(seen).toBe('solana');
  });
});


test('selected network scopes candidate wallets and their transaction evidence', async () => {
  const leaderboardCalls: unknown[][] = [];
  const transactionCalls: unknown[][] = [];
  let publications = 0;
  __setPublishDepsForTest({
    getLeaderboard: async (...args: unknown[]) => { leaderboardCalls.push(args); return { wallets: [{ address: 'same-address' }], total: 1 }; },
    getTransactions: async (...args: unknown[]) => { transactionCalls.push(args); return []; },
    calculateScore: () => { throw new Error('No score without evidence'); },
    getAdapter: () => ({
      readAttestation: async () => 0,
      publishAttestation: async () => { publications++; throw new Error('No publication in this test'); },
    }),
  });
  await publishTopScores(1, 'arc-mainnet');
  expect(leaderboardCalls).toEqual([[1, 0, { chain: 'arc-mainnet' }]]);
  expect(transactionCalls).toEqual([['same-address', 1000, 0, 'arc-mainnet']]);
  expect(publications).toBe(0);
});
