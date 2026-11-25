/// <reference types="bun-types" />
/**
 * publishTopScores dispatches to the right ChainAdapter and aggregates
 * PublishResults. We inject a fake leaderboard + fake adapter + fake score
 * inputs through the test seam — no DB, no chain calls.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { publishTopScores, __setPublishDepsForTest } from './publish';
import type { PublishResult } from '@/chain-adapters/types';
import type { ScoreInputs } from '@/scoring/wallet-score';

afterEach(() => __setPublishDepsForTest(null));

function inputs(over: Partial<ScoreInputs> = {}): ScoreInputs {
  return {
    wallet: 'W', chain: 'solana', transactions: [{ tx_signature: 'x' }] as never,
    feedback: { total: 0, delivered: 0, failed: 0, deliveryRate: 0 },
    manifestValue: null, signalEvents: [], agentBond: null, cadence: null, autonomy: null,
    degraded: [], ...over,
  };
}

function adapter(chain: string, published: string[] = []) {
  return {
    chain,
    async readAttestation() { return 0; },
    async publishAttestation(address: string): Promise<PublishResult> {
      published.push(address);
      return { address, dryRun: false, skipped: false, txId: 'tx_' + address };
    },
  };
}

describe('publishTopScores', () => {
  beforeEach(() => {
    __setPublishDepsForTest({
      getLeaderboard: async () => ({
        wallets: [{ address: 'GWALLET1' }, { address: 'GWALLET2' }], total: 2,
      }),
      gatherScoreInputs: async () => inputs(),
      scoreFromInputs: () => ({ score: 80, trustTier: 'Good' }),
      getAdapter: (chain: string) => adapter(chain),
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
      gatherScoreInputs: async () => inputs(),
      scoreFromInputs: () => ({ score: 80, trustTier: 'Good' }),
      getAdapter: (chain: string) => { seen = chain; return adapter(chain); },
    });
    await publishTopScores(1);
    expect(seen).toBe('solana');
  });

  test('publishes the full served score: gathered inputs, one pinned asOf for the run', async () => {
    const gathered: unknown[][] = [];
    const scored: unknown[][] = [];
    const full = inputs({ feedback: { total: 9, delivered: 9, failed: 0, deliveryRate: 1 } });
    __setPublishDepsForTest({
      getLeaderboard: async () => ({ wallets: [{ address: 'A' }, { address: 'B' }], total: 2 }),
      gatherScoreInputs: async (...a: unknown[]) => { gathered.push(a); return full; },
      scoreFromInputs: (...a: unknown[]) => { scored.push(a); return { score: 80, trustTier: 'Good' }; },
      getAdapter: (chain: string) => adapter(chain),
    });
    await publishTopScores(2, 'solana');
    expect(gathered.map((a) => a.slice(0, 2))).toEqual([['A', 'solana'], ['B', 'solana']]);
    const asOfA = (gathered[0][2] as { asOf: Date }).asOf;
    expect(asOfA).toBeInstanceOf(Date);
    expect((gathered[1][2] as { asOf: Date }).asOf).toBe(asOfA);
    expect(scored[0]).toEqual([full, { asOf: asOfA }]);
  });

  test('never publishes a score built from an unreadable input', async () => {
    const published: string[] = [];
    __setPublishDepsForTest({
      getLeaderboard: async () => ({ wallets: [{ address: 'A' }], total: 1 }),
      gatherScoreInputs: async () => inputs({ degraded: ['feedback'] }),
      scoreFromInputs: () => ({ score: 80, trustTier: 'Good' }),
      getAdapter: (chain: string) => adapter(chain, published),
    });
    const r = await publishTopScores(1, 'solana');
    expect(published).toEqual([]);
    expect(r.skipped).toBe(1);
    expect(r.details[0].reason).toContain('feedback');
  });
});

test('selected network scopes candidate wallets and their evidence', async () => {
  const leaderboardCalls: unknown[][] = [];
  const gatherCalls: unknown[][] = [];
  let publications = 0;
  __setPublishDepsForTest({
    getLeaderboard: async (...args: unknown[]) => { leaderboardCalls.push(args); return { wallets: [{ address: 'same-address' }], total: 1 }; },
    gatherScoreInputs: async (...args: unknown[]) => { gatherCalls.push(args); return inputs({ transactions: [] }); },
    scoreFromInputs: () => null,
    getAdapter: () => ({
      readAttestation: async () => 0,
      publishAttestation: async () => { publications++; throw new Error('No publication in this test'); },
    }),
  });
  await publishTopScores(1, 'arc-mainnet');
  expect(leaderboardCalls).toEqual([[1, 0, { chain: 'arc-mainnet' }]]);
  expect(gatherCalls.map((a) => a.slice(0, 2))).toEqual([['same-address', 'arc-mainnet']]);
  expect(publications).toBe(0);
});
