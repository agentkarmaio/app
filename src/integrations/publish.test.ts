/// <reference types="bun-types" />
/**
 * publishTopScores dispatches to the right ChainAdapter and aggregates
 * PublishResults. We inject a fake leaderboard + fake adapter through the
 * test seam — no DB, no chain calls.
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { publishTopScores, __setPublishDepsForTest } from './publish';
import type { PublishResult } from '@/chain-adapters/types';

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
