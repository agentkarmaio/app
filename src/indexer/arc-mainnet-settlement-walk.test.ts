import { afterEach, expect, setSystemTime, spyOn, test } from 'bun:test';
import * as db from '@/db/client';
import { runWithIndexingContext } from '@/db/indexing-context';
import { walkArcMainnetSettlement } from './arc-mainnet-settlement-walk';
import type { WalkChainTransport, WalkReceipt } from './arc-mainnet-settlement-walk';

const address = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;
const now = new Date('2026-09-26T12:00:00Z');
const restores: Array<() => void> = [];
afterEach(() => { restores.splice(0).reverse().forEach(restore => restore()); db.__setSupabaseForTest(null); setSystemTime(); });
function track<T extends { mockRestore(): void }>(spy: T): T { restores.push(() => spy.mockRestore()); return spy; }

interface StatsRow { address: string; settled_count: number; failed_count: number; last_block: number }

interface SetupOptions {
  wallets: string[];
  cursor?: string;
  priorStats?: StatsRow[];
  upsertError?: unknown;
}
function setup(options: SetupOptions) {
  setSystemTime(now);
  const { wallets, cursor = '', priorStats = [] } = options;
  const statsUpserted: Array<Record<string, unknown>> = [];
  const rateWrites: Array<Record<string, unknown>> = [];
  const from = (table: string) => {
    if (table === 'wallets') {
      const b: Record<string, unknown> = {};
      b.update = (row: Record<string, unknown>) => {
        rateWrites.push(row);
        const u: Record<string, unknown> = {};
        u.eq = (column: string, value: string) => {
          if (column === 'address') (row as { __address?: string }).__address = value;
          return u;
        };
        u.then = (resolve: (value: unknown) => void) => resolve({ error: null });
        return u;
      };
      b.select = () => {
        const s: Record<string, unknown> = {};
        s.eq = (column: string, value: string) => {
          expect(column).toBe('chain');
          expect(value).toBe('arc-mainnet');
          return s;
        };
        s.then = (resolve: (value: unknown) => void) =>
          resolve({ data: wallets.map(address => ({ address })), error: null });
        return s;
      };
      return b;
    }
    if (table === 'wallet_tx_stats') {
      const b: Record<string, unknown> = {};
      b.select = () => {
        const s: Record<string, unknown> = {};
        s.eq = (column: string, value: string) => {
          expect(column).toBe('chain');
          expect(value).toBe('arc-mainnet');
          return s;
        };
        s.then = (resolve: (value: unknown) => void) =>
          resolve({ data: priorStats.map(r => ({ ...r })), error: null });
        return s;
      };
      b.upsert = (rows: Array<Record<string, unknown>>, opts: { onConflict: string }) => {
        expect(opts.onConflict).toBe('chain,address');
        statsUpserted.push(...rows);
        const u: Record<string, unknown> = {};
        u.then = (resolve: (value: unknown) => void) => resolve({ error: options.upsertError ?? null });
        return u;
      };
      return b;
    }
    throw new Error(`unexpected table ${table}`);
  };
  db.__setSupabaseForTest({ from } as unknown);
  const saveCursor = track(spyOn(db, 'upsertCursor').mockImplementation(async (key, _value, _slot, chain) => {
    expect(key).toBe('arc-mainnet-block-walk');
    expect(chain).toBe('arc-mainnet');
    return undefined;
  }));
  track(spyOn(db, 'getCursor').mockImplementation(async (key, chain) => {
    expect(chain).toBe('arc-mainnet');
    expect(key).toBe('arc-mainnet-block-walk');
    return { chain: 'arc-mainnet', facilitator: key, last_signature: cursor, last_slot: null, updated_at: now.toISOString() };
  }));
  return { statsUpserted, rateWrites, saveCursor };
}

const CHAIN_ID = '0x13b2';
function transport(options: {
  head: number;
  receipts: Map<number, WalkReceipt[]>;
  failFromBlock?: number;
}): WalkChainTransport & { calls: number[][] } {
  const { head, receipts, failFromBlock = Number.POSITIVE_INFINITY } = options;
  const calls: number[][] = [];
  return {
    calls,
    getChainId: async () => CHAIN_ID,
    getHead: async () => `0x${head.toString(16)}`,
    fetchReceipts: async (blocks: number[]) => {
      calls.push([...blocks]);
      if (blocks.some(block => block >= failFromBlock)) throw new Error('rpc_throttled');
      return blocks.map(block => receipts.get(block) ?? []);
    },
  };
}

const r = (from: string, status: string): WalkReceipt => ({ from, status });
const ok = (from: string) => r(from, '0x1');
const failed = (from: string) => r(from, '0x0');

const W1 = address(1);
const W2 = address(2);

const managed = (opts: Parameters<typeof walkArcMainnetSettlement>[0] = {}) => runWithIndexingContext({
  chain: 'arc-mainnet', path: 'transfers', owner: 'test-owner', signal: opts?.signal,
}, () => walkArcMainnetSettlement(opts));

test('counts outgoing receipts per wallet and writes cumulative rates', async () => {
  const state = setup({ wallets: [W1, W2] });
  // Window 100..103 (start block 100, head 104). Outgoing ok/error pairs plus
  // incoming noise from a non-wallet and a status the ledger never emits.
  const receipts = new Map<number, WalkReceipt[]>([
    [100, [ok(W1), failed(W2), ok(address(9)), failed(W1), r(W1, '0x2')]],
    [101, [ok(W1), failed(W1), ok(W2)]],
    [102, [ok(W2)]],
    [103, []],
  ]);
  const rpc = transport({ head: 104, receipts });
  const result = await managed({ transport: rpc, startBlock: 100, batchSize: 2 });
  expect(result).toEqual({ scanned: 4, walletsUpdated: 2, complete: true, cursor: '103' });
  expect(rpc.calls).toEqual([[100, 101], [102, 103]]);
  expect(state.rateWrites).toEqual([
    expect.objectContaining({ metric_success_rate: 2 / 4, __address: W1 }),
    expect.objectContaining({ metric_success_rate: 2 / 3, __address: W2 }),
  ]);
  // Targeted update only: the walk must never touch score columns.
  expect(Object.keys(state.rateWrites[0]).sort()).toEqual(['__address', 'metric_success_rate']);
  expect(state.statsUpserted).toEqual([
    expect.objectContaining({ chain: 'arc-mainnet', address: W1, settled_count: 2, failed_count: 2, last_block: 103 }),
    expect.objectContaining({ chain: 'arc-mainnet', address: W2, settled_count: 2, failed_count: 1, last_block: 103 }),
  ]);
  expect(Object.keys(state.statsUpserted[0]).sort())
    .toEqual(['address', 'chain', 'failed_count', 'last_block', 'settled_count', 'updated_at']);
  expect(state.saveCursor).toHaveBeenCalledTimes(1);
});

test('resumes at the stored block cursor and merges into prior counters', async () => {
  const state = setup({
    wallets: [W1, W2],
    cursor: '101',
    priorStats: [{ address: W1, settled_count: 4, failed_count: 0, last_block: 101 }],
  });
  const receipts = new Map<number, WalkReceipt[]>([
    [102, [ok(W1), failed(W2)]],
    [103, [ok(W2), ok(W2)]],
  ]);
  const rpc = transport({ head: 104, receipts });
  const result = await managed({ transport: rpc, startBlock: 100, batchSize: 2 });
  expect(result).toEqual({ scanned: 2, walletsUpdated: 2, complete: true, cursor: '103' });
  expect(rpc.calls).toEqual([[102, 103]]);
  expect(state.rateWrites).toEqual([
    expect.objectContaining({ metric_success_rate: 1, __address: W1 }),
    expect.objectContaining({ metric_success_rate: 2 / 3, __address: W2 }),
  ]);
  expect(state.statsUpserted).toEqual([
    expect.objectContaining({ address: W1, settled_count: 5, failed_count: 0, last_block: 103 }),
    expect.objectContaining({ address: W2, settled_count: 2, failed_count: 1, last_block: 103 }),
  ]);
});

test('the per-wallet high-water mark skips blocks already counted by a crashed run', async () => {
  // Stats were committed through block 103 while the cursor stayed at 99:
  // rescanning 100..103 must not recount W1, and must still advance the cursor.
  const state = setup({
    wallets: [W1, W2],
    priorStats: [{ address: W1, settled_count: 10, failed_count: 2, last_block: 103 }],
  });
  const receipts = new Map<number, WalkReceipt[]>([
    [100, [ok(W1)]],
    [101, [failed(W1)]],
    [102, [ok(W2)]],
    [103, [ok(W2)]],
  ]);
  const rpc = transport({ head: 104, receipts });
  const result = await managed({ transport: rpc, startBlock: 100, batchSize: 2 });
  expect(result).toEqual({ scanned: 4, walletsUpdated: 1, complete: true, cursor: '103' });
  expect(state.rateWrites).toEqual([expect.objectContaining({ metric_success_rate: 1, __address: W2 })]);
  expect(state.statsUpserted).toEqual([
    expect.objectContaining({ address: W2, settled_count: 2, failed_count: 0, last_block: 103 }),
  ]);
});

test('a block cap stops the run resumably with the cursor held', async () => {
  const state = setup({ wallets: [W1] });
  const receipts = new Map<number, WalkReceipt[]>([[100, [ok(W1)]], [101, [failed(W1)]]]);
  const rpc = transport({ head: 1_000, receipts });
  const result = await managed({ transport: rpc, startBlock: 100, batchSize: 2, maxBlocks: 2 });
  expect(result).toEqual({ scanned: 2, walletsUpdated: 1, complete: false, cursor: '101' });
  expect(rpc.calls).toEqual([[100, 101]]);
  expect(state.saveCursor).toHaveBeenCalledTimes(1);
});

test('an RPC failure after bounded retries stops without advancing past the failed batch', async () => {
  const state = setup({ wallets: [W1] });
  const receipts = new Map<number, WalkReceipt[]>([[100, [ok(W1)]]]);
  const rpc = transport({ head: 104, receipts, failFromBlock: 102 });
  const result = await managed({
    transport: rpc, startBlock: 100, batchSize: 2, retryAttempts: 1, retryDelayMs: 0,
  });
  expect(result).toEqual({ scanned: 2, walletsUpdated: 1, complete: false, cursor: '101' });
  // First batch once, second batch once + one retry.
  expect(rpc.calls).toEqual([[100, 101], [102, 103], [102, 103]]);
  expect(state.saveCursor).toHaveBeenCalledTimes(1);
});

test('a database write failure throws after the walk', async () => {
  setup({ wallets: [W1], upsertError: { message: 'write failed' } });
  const receipts = new Map<number, WalkReceipt[]>([[100, [ok(W1)]]]);
  const rpc = transport({ head: 101, receipts });
  await expect(managed({ transport: rpc, startBlock: 100 }))
    .rejects.toThrow('write failed');
});

test('the walk runs only under the managed arc-mainnet transfers lease', async () => {
  await expect(walkArcMainnetSettlement({
    transport: transport({ head: 104, receipts: new Map() }), startBlock: 100,
  })).rejects.toThrow('arc_mainnet_lease_required');
});

test('an empty wallet set completes without touching the chain', async () => {
  const state = setup({ wallets: [] });
  const receipts = new Map<number, WalkReceipt[]>();
  const rpc = transport({ head: 104, receipts });
  const result = await managed({ transport: rpc, startBlock: 100 });
  expect(result).toEqual({ scanned: 0, walletsUpdated: 0, complete: true, cursor: '' });
  expect(rpc.calls).toEqual([]);
  expect(state.saveCursor).not.toHaveBeenCalled();
});

test('a walk already at the tip completes without refetching', async () => {
  const state = setup({ wallets: [W1], cursor: '103' });
  const rpc = transport({ head: 104, receipts: new Map() });
  const result = await managed({ transport: rpc, startBlock: 100 });
  expect(result).toEqual({ scanned: 0, walletsUpdated: 0, complete: true, cursor: '103' });
  expect(rpc.calls).toEqual([]);
  expect(state.saveCursor).not.toHaveBeenCalled();
});

test('a non-arc chain id is refused before any receipt fetch', async () => {
  setup({ wallets: [W1] });
  const rpc = { ...transport({ head: 104, receipts: new Map() }), getChainId: async () => '0x1' };
  await expect(managed({ transport: rpc, startBlock: 100 })).rejects.toThrow('arc_mainnet_chain_mismatch');
});

test('a walk needs a start block when no cursor exists', async () => {
  setup({ wallets: [W1] });
  await expect(managed({ transport: transport({ head: 104, receipts: new Map() }) }))
    .rejects.toThrow('arc_mainnet_walk_start_missing');
});

test('a malformed cursor value is refused', async () => {
  setup({ wallets: [W1], cursor: '0xzz' });
  await expect(managed({ transport: transport({ head: 104, receipts: new Map() }), startBlock: 100 }))
    .rejects.toThrow('arc_mainnet_walk_cursor_invalid');
});