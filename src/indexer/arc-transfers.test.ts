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
  const inserted: unknown[] = [];
  const signals: unknown[] = [];
  const ensured: string[] = [];
  const cursors: Array<[string, string, number | undefined]> = [];
  let getLogsCalls = 0;

  const deps = {
    usdcContract: ARC_USDC_CONTRACT,
    getHead: async () => BigInt(100),
    getLogs: async () => { getLogsCalls++; return transfers; },
    blockTimestamp: async () => TS,
    insertTransactions: async (rows: unknown[]) => { inserted.push(...rows); return rows.length; },
    insertSignalEvents: async (s: unknown[]) => { signals.push(...s); return s.length; },
    ensureWallets: async (addresses: string[]) => { ensured.push(...addresses); },
    getCursor: async () => null,
    upsertCursor: async (key: string, last: string, slot?: number) => { cursors.push([key, last, slot]); },
    ...overrides,
  };

  return { deps, state: { inserted, signals, ensured, cursors, get getLogsCalls() { return getLogsCalls; } } };
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

describe('arcTransfersIndexer — block-timestamp prefetch', () => {
  // Timestamps are this indexer's dominant RPC cost: one getBlock per distinct
  // block, up to 500 per window. Fetching them lazily inside the per-transfer
  // loop meant ~500 SEQUENTIAL round trips (~13s/window), which held catch-up to
  // ~18k blocks/day against a chain producing ~166k — it lost ground every day.
  test('fetches each distinct block ONCE and overlaps the lookups', async () => {
    // 40 transfers spread over 8 distinct blocks, 5 transfers per block.
    const transfers = Array.from({ length: 40 }, (_, i) =>
      transfer({
        rawAmount: BigInt(1_000_000),
        block: BigInt(100 + (i % 8)),
        txHash: `0xtx${i}` as `0x${string}`,
      }),
    );

    const seen: string[] = [];
    let inFlight = 0;
    let peakInFlight = 0;
    const { deps } = makeDeps(transfers, {
      getHead: async () => BigInt(107),
      blockTimestamp: async (b: bigint) => {
        seen.push(b.toString());
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return TS;
      },
    });

    await arcTransfersIndexer(deps);

    // Deduped: 8 distinct blocks, not 40 transfers.
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
    // Overlapped rather than awaited one at a time — the whole point.
    expect(peakInFlight).toBeGreaterThan(1);
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

    expect(state.inserted).toHaveLength(1);
    const row = state.inserted[0] as any;
    expect(row.wallet_address).toBe(FROM);
    expect(row.counterparty).toBe(TO);
    expect(row.facilitator).toBe(ARC_USDC_CONTRACT);
    expect(row.amount).toBe(1);

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
