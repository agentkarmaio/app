/// <reference types="bun-types" />
/**
 * Arc plain USDC-transfer Tier-1 indexer tests.
 *
 * Mock strategy: DEPENDENCY INJECTION, mirrors arc-jobs.test.ts. The novel
 * case here (arc-jobs has no equivalent) is the escrow-internal-transfer skip:
 * a Transfer where either side is ARC_JOBS_CONTRACT must produce ZERO signals
 * — arc-jobs.ts already covers that movement at full strength, and double
 * counting it here would inflate Karma for the same underlying settlement.
 *
 * Run: bun test src/indexer/arc-transfers.test.ts
 */

import { describe, expect, test } from 'bun:test';
import {
  parseTransfer,
  arcTransfersIndexer,
  arcTransfersCursorKey,
  ARC_USDC_CONTRACT,
  TRANSFER_EVENT,
  type ArcTransfer,
} from './arc-transfers';
import { ARC_JOBS_CONTRACT } from './arc-jobs';
import type { Log } from 'viem';

const FROM = '0x1111111111111111111111111111111111111111' as const;
const TO = '0x2222222222222222222222222222222222222222' as const;
const TS = '2026-07-11T00:00:00.000Z';

function transfer(opts: {
  from?: `0x${string}`; to?: `0x${string}`; rawAmount: bigint;
  block?: bigint; txHash?: `0x${string}`;
}): ArcTransfer {
  return {
    from: opts.from ?? FROM,
    to: opts.to ?? TO,
    rawAmount: opts.rawAmount,
    amount: Number(opts.rawAmount) / 1e6,
    blockNumber: opts.block ?? BigInt(100),
    txHash: opts.txHash ?? '0xtransfer',
  };
}

function makeDeps(
  transfers: ArcTransfer[],
  overrides: Partial<Parameters<typeof arcTransfersIndexer>[0]> = {},
) {
  const signals: unknown[] = [];
  const ensured: string[] = [];
  const cursors: Array<[string, string, number | undefined]> = [];
  let getLogsCalls = 0;

  const deps = {
    usdcContract: ARC_USDC_CONTRACT,
    getHead: async () => BigInt(100),
    getLogs: async () => { getLogsCalls++; return transfers; },
    blockTimestamp: async () => TS,
    insertSignalEvents: async (s: unknown[]) => { signals.push(...s); return s.length; },
    ensureWallet: async (a: string) => { ensured.push(a); },
    getCursor: async () => null,
    upsertCursor: async (key: string, last: string, slot?: number) => { cursors.push([key, last, slot]); },
    ...overrides,
  };

  return { deps, state: { signals, ensured, cursors, get getLogsCalls() { return getLogsCalls; } } };
}

describe('parseTransfer', () => {
  test('decodes from/to/value', () => {
    const log = {
      args: { from: FROM, to: TO, value: BigInt(500_000) },
      blockNumber: BigInt(10),
      transactionHash: '0xabc',
    } as unknown as Log<bigint, number, false, typeof TRANSFER_EVENT>;
    const rec = parseTransfer(log);
    expect(rec).not.toBeNull();
    expect(rec!.from).toBe(FROM);
    expect(rec!.to).toBe(TO);
    expect(rec!.amount).toBe(0.5);
  });

  test('returns null on missing value', () => {
    const log = {
      args: { from: FROM, to: TO },
      blockNumber: BigInt(10), transactionHash: '0xabc',
    } as unknown as Log<bigint, number, false, typeof TRANSFER_EVENT>;
    expect(parseTransfer(log)).toBeNull();
  });
});

describe('arcTransfersIndexer', () => {
  test('emits a provider + consumer signal pair for a plain transfer', async () => {
    const { deps, state } = makeDeps([transfer({ rawAmount: BigInt(1_000_000) })]);
    const result = await arcTransfersIndexer(deps);

    expect(result.fetched).toBe(1);
    expect(result.inserted).toBe(2);
    expect(state.signals).toHaveLength(2);
    expect(state.ensured).toEqual(expect.arrayContaining([FROM, TO]));

    const provider = state.signals.find((s: any) => s.face === 'provider') as any;
    const consumer = state.signals.find((s: any) => s.face === 'consumer') as any;
    expect(provider.agentWallet).toBe(TO);
    expect(provider.chain).toBe('arc');
    expect(provider.kind).toBe('usdc_transfer_settled');
    expect(provider.weight).toBe(0.6);
    expect(consumer.agentWallet).toBe(FROM);
    expect(consumer.chain).toBe('arc');
  });

  test('skips a transfer where the escrow contract is either side (arc-jobs already covers it)', async () => {
    const escrowFunding = transfer({ from: FROM, to: ARC_JOBS_CONTRACT as `0x${string}`, rawAmount: BigInt(1_000_000) });
    const escrowPayout = transfer({ from: ARC_JOBS_CONTRACT as `0x${string}`, to: TO, rawAmount: BigInt(1_000_000), block: BigInt(101) });
    const genuine = transfer({ rawAmount: BigInt(2_000_000), block: BigInt(102) });

    const { deps, state } = makeDeps([escrowFunding, escrowPayout, genuine]);
    const result = await arcTransfersIndexer(deps);

    expect(result.fetched).toBe(1); // only the genuine transfer counts
    expect(state.signals).toHaveLength(2);
    expect((state.signals[0] as any).payload.amount).toBe(2);
  });

  test('no-op when cursor already at head', async () => {
    const { deps, state } = makeDeps([transfer({ rawAmount: BigInt(1_000_000) })], {
      getCursor: async () => ({ last_signature: '100', last_slot: 100 }),
      getHead: async () => BigInt(100),
    });
    const result = await arcTransfersIndexer(deps);
    expect(result.fetched).toBe(0);
    expect(state.signals).toHaveLength(0);
  });

  test('advances cursor to head even with zero transfers', async () => {
    const { deps, state } = makeDeps([]);
    const result = await arcTransfersIndexer(deps);
    expect(result.fetched).toBe(0);
    expect(state.cursors).toHaveLength(1);
    expect(state.cursors[0][1]).toBe('100');
  });
});

describe('arcTransfersCursorKey', () => {
  test('is namespaced by the USDC contract, distinct from arc-jobs', () => {
    const key = arcTransfersCursorKey(ARC_USDC_CONTRACT);
    expect(key).toBe(`arc-transfers:${ARC_USDC_CONTRACT}`);
    expect(key).not.toContain(ARC_JOBS_CONTRACT);
  });
});
