import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { celoX402Indexer } from '../indexer/celo-x402';
import { INDEXABLE_HEAD_MARGIN_BLOCKS, readIndexableHead } from './rpc-head';

const FACILITATOR = '0x1111111111111111111111111111111111111111';

/**
 * Forno balances requests across backends that disagree on the tip: a getLogs
 * reaching past the backend that serves it answers `-32019 block is out of
 * range`, measured on 11 of 60 head-then-getLogs pairs (2026-11-05).
 */
function laggingForno(tip: bigint, lag: bigint) {
  return {
    getBlockNumber: async () => tip,
    getLogs: async (_from: bigint, to: bigint) => {
      if (to > tip - lag) throw new Error('block is out of range');
      return [];
    },
  };
}

function scan(rpc: ReturnType<typeof laggingForno>, getHead: () => Promise<bigint>) {
  return celoX402Indexer({
    facilitators: new Set([FACILITATOR]),
    getHead,
    getLogs: rpc.getLogs,
    blockTimestamp: async () => '2026-11-05T00:00:00.000Z',
    insertTransactions: async () => 0,
    insertSignalEvents: async () => 0,
    ensureWallet: async () => {},
    getCursor: async () => ({ last_signature: '999', last_slot: 999 }),
    upsertCursor: async () => {},
    startBlockFallback: BigInt(0),
  });
}

describe('readIndexableHead', () => {
  test('stays behind the reported tip', async () => {
    const head = await readIndexableHead({ getBlockNumber: async () => BigInt(1_000) });
    expect(head).toBe(BigInt(1_000) - INDEXABLE_HEAD_MARGIN_BLOCKS);
  });

  test('never goes below genesis', async () => {
    expect(await readIndexableHead({ getBlockNumber: async () => BigInt(1) })).toBe(BigInt(0));
  });

  test('a scan to the raw tip fails on a lagging backend (negative control)', async () => {
    const rpc = laggingForno(BigInt(2_000), BigInt(2));
    await expect(scan(rpc, rpc.getBlockNumber)).rejects.toThrow('block is out of range');
  });

  test('a scan to the indexable head survives the same backend', async () => {
    const rpc = laggingForno(BigInt(2_000), BigInt(2));
    const result = await scan(rpc, () => readIndexableHead(rpc));
    expect(result.coverage.complete).toBe(true);
    expect(result.coverage.head).toBe(String(BigInt(2_000) - INDEXABLE_HEAD_MARGIN_BLOCKS));
  });
});

describe('Forno getLogs scanners', () => {
  // The call sites build a real viem client, so the wiring cannot be reached
  // from a unit test. One raw head read brings the page back, so hold it here.
  const scanners = [
    'indexer/celo-x402.ts',
    'indexer/celo-x402-relayer.ts',
    'indexer/erc8004-feedback-uri.ts',
    'indexer/erc8004-feedback-uri-run.ts',
  ];
  for (const file of scanners) {
    test(`${file} reads the head through readIndexableHead`, () => {
      const source = readFileSync(join(import.meta.dir, '..', file), 'utf8');
      expect(source).toContain('readIndexableHead');
      expect(source).not.toContain('client.getBlockNumber()');
    });
  }
});
