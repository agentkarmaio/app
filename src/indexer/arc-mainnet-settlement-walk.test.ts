import { afterEach, expect, setSystemTime, spyOn, test } from 'bun:test';
import * as db from '@/db/client';
import { runWithIndexingContext } from '@/db/indexing-context';
import { createArcMainnetWalkTransport, walkArcMainnetSettlement } from './arc-mainnet-settlement-walk';
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
  rateError?: unknown;
  rotation?: string;
  legacyStats?: boolean;
  target?: string;
  provenance?: Record<string, string>;
  markerError?: boolean;
}
/** PostgREST-shaped paged select: honours .range() and caps a page at 1000 rows. */
function pagedSelect(rows: () => Array<Record<string, unknown>>, reads: Array<[number, number]>, sortColumn = 'address') {
  const s: Record<string, unknown> = {};
  let window: [number, number] = [0, Number.POSITIVE_INFINITY];
  s.eq = (column: string, value: string) => {
    expect(column).toBe('chain');
    expect(value).toBe('arc-mainnet');
    return s;
  };
  s.order = (column: string) => { expect(column).toBe(sortColumn); return s; };
  s.like = () => s;
  s.range = (from: number, to: number) => { window = [from, to]; reads.push(window); return s; };
  s.then = (resolve: (value: unknown) => void) => {
    const end = Math.min(window[1] + 1, window[0] + 1000);
    resolve({ data: rows().slice(window[0], end), error: null });
  };
  return s;
}
function setup(options: SetupOptions) {
  setSystemTime(now);
  const { wallets, cursor = '', priorStats = [] } = options;
  const statsUpserted: Array<Record<string, unknown>> = [];
  const rateWrites: Array<Record<string, unknown>> = [];
  const pageReads: Record<string, Array<[number, number]>> = { wallets: [], wallet_tx_stats: [] };
  const order: string[] = [];
  const from = (table: string) => {
    if (table === 'wallets') {
      const b: Record<string, unknown> = {};
      b.update = (row: Record<string, unknown>) => {
        rateWrites.push(row);
        order.push('rate');
        const u: Record<string, unknown> = {};
        u.eq = (column: string, value: string) => {
          if (column === 'address') (row as { __address?: string }).__address = value;
          return u;
        };
        u.then = (resolve: (value: unknown) => void) => resolve({ error: options.rateError ?? null });
        return u;
      };
      b.select = () => pagedSelect(() => wallets.map(address => ({ address })), pageReads.wallets);
      return b;
    }
    if (table === 'wallet_tx_stats') {
      const b: Record<string, unknown> = {};
      b.select = () => pagedSelect(() => priorStats.map(r => ({ ...r })), pageReads.wallet_tx_stats);
      b.upsert = (rows: Array<Record<string, unknown>>, opts: { onConflict: string }) => {
        expect(opts.onConflict).toBe('chain,address');
        statsUpserted.push(...rows);
        order.push('stats');
        const u: Record<string, unknown> = {};
        u.then = (resolve: (value: unknown) => void) => resolve({ error: options.upsertError ?? null });
        return u;
      };
      return b;
    }
    if (table === 'indexer_cursors') return { select: () => pagedSelect(() => priorStats.filter(() => !options.legacyStats).map(row => ({ facilitator: 'arc-mainnet-settlement-v1:' + row.address, last_signature: options.provenance?.[row.address] ?? String(row.last_block) })), [], 'facilitator') };
    throw new Error(`unexpected table ${table}`);
  };
  db.__setSupabaseForTest({ from } as unknown);
  const saveCursor = track(spyOn(db, 'upsertCursor').mockImplementation(async (key, _value, _slot, chain) => {
    expect(key === 'arc-mainnet-settlement-target-v1' || key === 'arc-mainnet-block-walk' || key === 'arc-mainnet-settlement-rotation' || key.startsWith('arc-mainnet-settlement-v1:')).toBe(true);
    expect(chain).toBe('arc-mainnet');
    if (options.markerError && key.startsWith('arc-mainnet-settlement-v1:')) throw new Error('marker_write_failed');
    return undefined;
  }));
  track(spyOn(db, 'getCursor').mockImplementation(async (key, chain) => {
    expect(chain).toBe('arc-mainnet');
    expect(key === 'arc-mainnet-settlement-target-v1' || key === 'arc-mainnet-block-walk' || key === 'arc-mainnet-settlement-rotation' || key.startsWith('arc-mainnet-settlement-v1:')).toBe(true);
    return { chain: 'arc-mainnet', facilitator: key, last_signature: key === 'arc-mainnet-settlement-target-v1' ? options.target ?? '' : key.startsWith('arc-mainnet-settlement-v1:') ? (options.legacyStats ? '' : String(priorStats.find(row => key.endsWith(row.address))?.last_block ?? '')) : key === 'arc-mainnet-settlement-rotation' ? options.rotation ?? '' : cursor, last_slot: null, updated_at: now.toISOString() };
  }));
  return { statsUpserted, rateWrites, saveCursor, pageReads, order };
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

test('a walk defaults to genesis when no cursor exists', async () => {
  setup({ wallets: [W1] });
  await expect(managed({ transport: transport({ head: 104, receipts: new Map() }) }))
    .resolves.toEqual(expect.objectContaining({ complete: true, scanned: 104 }));
});

test('a malformed cursor value is refused', async () => {
  setup({ wallets: [W1], cursor: '0xzz' });
  await expect(managed({ transport: transport({ head: 104, receipts: new Map() }), startBlock: 100 }))
    .rejects.toThrow('arc_mainnet_walk_cursor_invalid');
});
test('work-set reads page past the 1000-row cap so prior counters are never lost', async () => {
  // 1500 wallets with committed counters; the one that transacts sits on page 2.
  const wallets = Array.from({ length: 1500 }, (_, i) => address(i + 1));
  const late = wallets[1200];
  const state = setup({
    wallets,
    cursor: '99',
    priorStats: wallets.map(a => ({ address: a, settled_count: 7, failed_count: 3, last_block: 99 })),
  });
  const rpc = transport({ head: 101, receipts: new Map([[100, [ok(late)]]]) });
  const result = await managed({ transport: rpc, startBlock: 100 });
  expect(result).toEqual({ scanned: 1, walletsUpdated: 1, complete: true, cursor: '100' });
  expect(state.pageReads.wallets).toEqual([[0, 999], [1000, 1999]]);
  expect(state.pageReads.wallet_tx_stats).toEqual([[0, 999], [1000, 1999]]);
  // Merged into the page-2 prior, not restarted from zero.
  expect(state.statsUpserted).toEqual([
    expect.objectContaining({ address: late, settled_count: 8, failed_count: 3, last_block: 100 }),
  ]);
  expect(state.rateWrites).toEqual([expect.objectContaining({ metric_success_rate: 8 / 11, __address: late })]);
});

test('rates land before counters so a failed rate write leaves the blocks recountable', async () => {
  const state = setup({ wallets: [W1], rateError: { message: 'rate write failed' } });
  const rpc = transport({ head: 102, receipts: new Map([[100, [ok(W1)]], [101, [failed(W1)]]]) });
  await expect(managed({ transport: rpc, startBlock: 100 })).rejects.toThrow('rate write failed');
  // No counter commit and no cursor advance: the next run recounts and re-derives.
  expect(state.statsUpserted).toEqual([]);
  expect(state.saveCursor).not.toHaveBeenCalled();
});

test('counter writes follow every rate write', async () => {
  const state = setup({ wallets: [W1, W2] });
  const rpc = transport({ head: 102, receipts: new Map([[100, [ok(W1)]], [101, [failed(W2)]]]) });
  await managed({ transport: rpc, startBlock: 100 });
  expect(state.order).toEqual(['rate', 'rate', 'stats']);
});

test('an unreachable chain id stops resumably and reports the held cursor', async () => {
  setup({ wallets: [W1], cursor: '150' });
  const rpc = {
    ...transport({ head: 200, receipts: new Map() }),
    getChainId: async () => { throw new Error('rpc_down'); },
  };
  const result = await managed({ transport: rpc, startBlock: 100, retryAttempts: 0 });
  expect(result).toEqual({ scanned: 0, walletsUpdated: 0, complete: false, cursor: '150' });
  expect(rpc.calls).toEqual([]);
});

test('a hung RPC request times out instead of waiting on the job abort', async () => {
  const hung = track(spyOn(globalThis, 'fetch').mockImplementation(((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as unknown as typeof fetch));
  const job = new AbortController();
  const rpc = createArcMainnetWalkTransport('https://rpc.example', job.signal, 20);
  await expect(rpc.getHead()).rejects.toThrow();
  expect(job.signal.aborted).toBe(false);
  expect(hung).toHaveBeenCalledTimes(1);
});

function sparse(head: number, receipts: Map<number, WalkReceipt[]>, extraNonce?: (wallet: string, block: number) => number) {
  const rpc = transport({ head, receipts });
  const nonceCalls: Array<[string, number]> = [];
  return { ...rpc, nonceCalls, getNonce: async (wallet: string, block: number) => {
    nonceCalls.push([wallet, block]);
    const count = [...receipts].reduce((sum, [height, rows]) => sum + (height <= block
      ? rows.filter(row => row.from?.toLowerCase() === wallet).length : 0), 0) + (extraNonce?.(wallet, block) ?? 0);
    return `0x${count.toString(16)}`;
  } };
}

test('sparse history starts at genesis despite a global cursor and skips million-block empty spans', async () => {
  const state = setup({ wallets: [W1], cursor: '999999' });
  const rpc = sparse(1_000_001, new Map([[700_000, [ok(W1), failed(W1)]]]));
  const result = await managed({ transport: rpc, retryAttempts: 0 });
  expect(result.complete).toBe(true);
  expect(rpc.calls).toEqual([[0], [700_000]]);
  expect(rpc.nonceCalls.length).toBeLessThan(30);
  expect(state.statsUpserted.at(-1)).toEqual(expect.objectContaining({
    address: W1, settled_count: 1, failed_count: 1, last_block: 1_000_000,
  }));
  expect(state.rateWrites.at(-1)?.metric_success_rate).toBe(0.5);
});

test('sparse zero-activity wallets receive verified coverage and a null success metric', async () => {
  const state = setup({ wallets: [W1] });
  const rpc = sparse(1001, new Map());
  expect((await managed({ transport: rpc, startBlock: 0 })).complete).toBe(true);
  expect(state.statsUpserted.at(-1)).toEqual(expect.objectContaining({ settled_count: 0, failed_count: 0, last_block: 1000 }));
  expect(state.rateWrites.at(-1)?.metric_success_rate).toBeNull();
});

test('sparse nonce-only authority bumps never fabricate receipt outcomes', async () => {
  const state = setup({ wallets: [W1] });
  const rpc = sparse(101, new Map([[0, [failed(W1)]]]), (_wallet, block) => block >= 70 ? 2 : 0);
  expect((await managed({ transport: rpc, startBlock: 0 })).complete).toBe(true);
  expect(rpc.calls).toEqual([[0], [70]]);
  expect(state.statsUpserted.at(-1)).toEqual(expect.objectContaining({ settled_count: 0, failed_count: 1, last_block: 100 }));
  expect(state.rateWrites.at(-1)?.metric_success_rate).toBe(0);
});

test('sparse malformed nonce cannot bank an empty range', async () => {
  const state = setup({ wallets: [W1], priorStats: [{ address: W1, settled_count: 1, failed_count: 0, last_block: 3 }] });
  const rpc = { ...sparse(101, new Map()), getNonce: async () => '0xnot-a-number' };
  expect((await managed({ transport: rpc, startBlock: 0, retryAttempts: 0 })).complete).toBe(false);
  expect(state.statsUpserted).toEqual([]);
});

test('sparse unknown receipt status leaves that block recountable', async () => {
  const state = setup({ wallets: [W1], priorStats: [{ address: W1, settled_count: 1, failed_count: 0, last_block: 3 }] });
  const rpc = sparse(101, new Map([[3, [ok(W1)]], [70, [r(W1, '0x2')]]]));
  expect((await managed({ transport: rpc, startBlock: 0, retryAttempts: 0 })).complete).toBe(false);
  expect(state.statsUpserted.every(row => Number(row.last_block) < 70)).toBe(true);
});


test('sparse legacy counters without provenance replay from genesis instead of claiming old coverage', async () => {
  const state = setup({ wallets: [W1], legacyStats: true,
    priorStats: [{ address: W1, settled_count: 99, failed_count: 1, last_block: 100 }] });
  const rpc = sparse(101, new Map([[5, [failed(W1)]]]));
  expect((await managed({ transport: rpc, retryAttempts: 0 })).complete).toBe(true);
  expect(state.statsUpserted.at(-1)).toEqual(expect.objectContaining({ settled_count: 0, failed_count: 1, last_block: 100 }));
});

test('sparse partial progress hides the success rate until full history is verified', async () => {
  const state = setup({ wallets: [W1] });
  const rpc = sparse(101, new Map([[0, [ok(W1)]], [90, [failed(W1)]]]));
  expect((await managed({ transport: rpc, maxBlocks: 1 })).complete).toBe(false);
  expect(state.statsUpserted.at(-1)).toEqual(expect.objectContaining({ last_block: 0, settled_count: 1 }));
  expect(state.rateWrites.at(-1)?.metric_success_rate).toBeNull();
  expect(state.order).toEqual(['rate', 'stats']);
});

test('sparse retry resumes verified per-wallet coverage without recounting committed receipts', async () => {
  const priorStats = [{ address: W1, settled_count: 1, failed_count: 0, last_block: 5 }];
  const state = setup({ wallets: [W1], priorStats, cursor: '100' });
  const rpc = sparse(101, new Map([[5, [ok(W1)]], [90, [failed(W1), ok(W1)]]]));
  expect((await managed({ transport: rpc })).complete).toBe(true);
  expect(rpc.calls).toEqual([[90]]);
  expect(state.statsUpserted.at(-1)).toEqual(expect.objectContaining({ settled_count: 2, failed_count: 1, last_block: 100 }));
});

test('sparse durable rotation gives the next wallet a turn after a bounded run', async () => {
  const state = setup({ wallets: [W1, W2], rotation: W1 });
  const rpc = sparse(101, new Map());
  await managed({ transport: rpc, maxBlocks: 1 });
  expect(state.statsUpserted[0].address).toBe(W2);
  expect(state.saveCursor.mock.calls.at(-1)?.slice(0, 2)).toEqual(['arc-mainnet-settlement-rotation', W2]);
});

test('sparse a failed receipt request preserves prior counters and coverage', async () => {
  const state = setup({ wallets: [W1], priorStats: [{ address: W1, settled_count: 1, failed_count: 0, last_block: 5 }] });
  const base = sparse(101, new Map([[5, [ok(W1)]], [90, [failed(W1)]]]));
  const rpc = { ...base, fetchReceipts: async () => { throw new Error('rate_limited'); } };
  expect((await managed({ transport: rpc, retryAttempts: 0 })).complete).toBe(false);
  expect(state.statsUpserted).toEqual([]);
  expect(state.saveCursor.mock.calls.every(([key]) => !key.startsWith('arc-mainnet-settlement-v1:'))).toBe(true);
});

test('sparse rate failure cannot persist stats or provenance', async () => {
  const state = setup({ wallets: [W1], rateError: new Error('rate_failed') });
  await expect(managed({ transport: sparse(101, new Map()), retryAttempts: 0 })).rejects.toThrow('rate_failed');
  expect(state.statsUpserted).toEqual([]);
  expect(state.saveCursor.mock.calls.every(([key]) => key === 'arc-mainnet-settlement-target-v1')).toBe(true);
});

test('sparse cancellation during RPC cannot write coverage or rotation', async () => {
  const state = setup({ wallets: [W1] });
  const controller = new AbortController();
  const rpc = { ...sparse(101, new Map()), fetchReceipts: async () => { controller.abort(); return [[]]; } };
  await expect(managed({ transport: rpc, signal: controller.signal, retryAttempts: 0 })).rejects.toThrow();
  expect(state.statsUpserted).toEqual([]);
  expect(state.saveCursor.mock.calls.every(([key]) => key === 'arc-mainnet-settlement-target-v1')).toBe(true);
});

test('sparse negative stored counters fail closed rather than silently erase history', async () => {
  const state = setup({ wallets: [W1], priorStats: [{ address: W1, settled_count: -1, failed_count: 0, last_block: 5 }] });
  await expect(managed({ transport: sparse(101, new Map()) })).rejects.toThrow('arc_mainnet_walk_stats_invalid');
  expect(state.statsUpserted).toEqual([]);
});


test('sparse frozen target preserves prior coverage without claiming current-head completion', async () => {
  const state = setup({ wallets: [W1, W2], rotation: W1, target: '100',
    priorStats: [{ address: W1, settled_count: 1, failed_count: 0, last_block: 100 },
      { address: W2, settled_count: 1, failed_count: 0, last_block: 10 }] });
  const rpc = sparse(201, new Map([[10, [ok(W2)]], [150, [failed(W2)]]]));
  expect((await managed({ transport: rpc })).complete).toBe(false);
  expect(rpc.nonceCalls.every(([, block]) => block <= 100)).toBe(true);
  expect(state.statsUpserted.at(-1)?.last_block).toBe(100);
});

test('sparse stats written before a crashed provenance write are replayed safely', async () => {
  const state = setup({ wallets: [W1], target: '100', provenance: { [W1]: '5' },
    priorStats: [{ address: W1, settled_count: 2, failed_count: 1, last_block: 90 }] });
  const rpc = sparse(101, new Map([[5, [ok(W1)]], [90, [failed(W1), ok(W1)]]]));
  expect((await managed({ transport: rpc })).complete).toBe(true);
  expect(rpc.calls[0]).toEqual([0]);
  expect(state.statsUpserted.at(-1)).toEqual(expect.objectContaining({ settled_count: 2, failed_count: 1 }));
});

test('sparse verified coverage ahead of the node fails closed without rewinding counters', async () => {
  const state = setup({ wallets: [W1], priorStats: [{ address: W1, settled_count: 1, failed_count: 0, last_block: 200 }] });
  await expect(managed({ transport: sparse(101, new Map()) })).rejects.toThrow('arc_mainnet_walk_head_behind');
  expect(state.statsUpserted).toEqual([]);
});


test('sparse verified published rates survive a partial incremental tail', async () => {
  const state = setup({ wallets: [W1], target: '5',
    priorStats: [{ address: W1, settled_count: 1, failed_count: 0, last_block: 5 }] });
  const rpc = sparse(101, new Map([[5, [ok(W1)]], [10, [failed(W1)]], [90, [ok(W1)]]]));
  expect((await managed({ transport: rpc, maxBlocks: 1 })).complete).toBe(false);
  expect(state.statsUpserted.at(-1)?.last_block).toBe(10);
  expect(state.rateWrites).toEqual([]);
});

test('sparse unproven legacy rates clear even when genesis RPC is unavailable', async () => {
  const state = setup({ wallets: [W1], legacyStats: true,
    priorStats: [{ address: W1, settled_count: 1, failed_count: 0, last_block: 5 }] });
  const rpc = { ...sparse(101, new Map()), fetchReceipts: async () => { throw new Error('rpc_down'); } };
  expect((await managed({ transport: rpc, retryAttempts: 0 })).complete).toBe(false);
  expect(state.rateWrites).toEqual([expect.objectContaining({ metric_success_rate: null })]);
  expect(state.statsUpserted).toEqual([]);
});


test('sparse completed frozen target advances on the next run even when the previous run was behind head', async () => {
  const state = setup({ wallets: [W1], target: '100',
    priorStats: [{ address: W1, settled_count: 1, failed_count: 0, last_block: 100 }] });
  const rpc = sparse(201, new Map([[50, [ok(W1)]]]));
  expect((await managed({ transport: rpc })).complete).toBe(true);
  expect(state.saveCursor.mock.calls).toContainEqual(['arc-mainnet-settlement-target-v1', '200', 200, 'arc-mainnet']);
  expect(state.statsUpserted.at(-1)?.last_block).toBe(200);
});


test('sparse marker write failure propagates and a restart recounts without doubling committed stats', async () => {
  const initial = setup({ wallets: [W1], target: '100', markerError: true,
    priorStats: [{ address: W1, settled_count: 1, failed_count: 0, last_block: 5 }] });
  const receipts = new Map([[5, [ok(W1)]], [90, [failed(W1)]]]);
  await expect(managed({ transport: sparse(101, receipts) })).rejects.toThrow('marker_write_failed');
  const committed = initial.statsUpserted.at(-1) as unknown as StatsRow;
  expect(committed).toEqual(expect.objectContaining({ last_block: 100, settled_count: 1, failed_count: 1 }));
  expect(initial.rateWrites.at(-1)?.metric_success_rate).toBe(0.5);
  expect(initial.saveCursor.mock.calls.every(([key]) => key !== 'arc-mainnet-settlement-rotation')).toBe(true);
  const restarted = setup({ wallets: [W1], target: '100', provenance: { [W1]: '5' }, priorStats: [committed] });
  expect((await managed({ transport: sparse(101, receipts) })).complete).toBe(true);
  expect(restarted.statsUpserted.at(-1)).toEqual(expect.objectContaining({ last_block: 100, settled_count: 1, failed_count: 1 }));
});

test.each(['-1', '0x20', '1.5', '9007199254740992'])('sparse malformed frozen target %s refuses progress', async target => {
  const state = setup({ wallets: [W1], target });
  await expect(managed({ transport: sparse(101, new Map()) })).rejects.toThrow('arc_mainnet_walk_cursor_invalid');
  expect(state.statsUpserted).toEqual([]);
  expect(state.saveCursor).not.toHaveBeenCalled();
});

test('sparse frozen target ahead of the observed node refuses progress', async () => {
  const state = setup({ wallets: [W1], target: '200' });
  await expect(managed({ transport: sparse(101, new Map()) })).rejects.toThrow('arc_mainnet_walk_head_behind');
  expect(state.saveCursor).not.toHaveBeenCalled();
});

test('sparse case-insensitive sender attribution excludes other senders in a candidate block', async () => {
  const wallet = address(0xabc);
  const state = setup({ wallets: [wallet.toUpperCase()] });
  const rpc = sparse(101, new Map([[80, [ok(wallet.toUpperCase()), failed(address(9))]]]));
  expect((await managed({ transport: rpc })).complete).toBe(true);
  expect(state.statsUpserted.at(-1)).toEqual(expect.objectContaining({ address: wallet, settled_count: 1, failed_count: 0 }));
});

test.each(['0x-1', '0x20000000000000', '0x01'])('sparse invalid archive quantity %s cannot certify an empty span', async value => {
  const state = setup({ wallets: [W1], target: '100', priorStats: [{ address: W1, settled_count: 1, failed_count: 0, last_block: 5 }] });
  const rpc = { ...sparse(101, new Map()), getNonce: async () => value };
  expect((await managed({ transport: rpc, retryAttempts: 0 })).complete).toBe(false);
  expect(state.statsUpserted).toEqual([]);
});

test.each(['decreasing', 'outside-bisection-bound'])('sparse %s nonces fail closed', async kind => {
  const state = setup({ wallets: [W1], target: '100', priorStats: [{ address: W1, settled_count: 1, failed_count: 0, last_block: 5 }] });
  const rpc = { ...sparse(101, new Map()), getNonce: async (_wallet: string, block: number) => {
    if (block === 5) return '0x1';
    if (block === 100) return kind === 'decreasing' ? '0x0' : '0x2';
    return '0x3';
  } };
  expect((await managed({ transport: rpc, retryAttempts: 0 })).complete).toBe(false);
  expect(state.statsUpserted).toEqual([]);
});

test.each([undefined, 'invalid-address'])('sparse malformed receipt sender %s leaves the candidate unscanned', async from => {
  const state = setup({ wallets: [W1] });
  const rpc = { ...sparse(101, new Map()), fetchReceipts: async () => [[{ from, status: '0x1' }]] };
  expect((await managed({ transport: rpc, retryAttempts: 0 })).complete).toBe(false);
  expect(state.statsUpserted).toEqual([]);
});

test('sparse provenance reads page past the response limit and preserve page-two counters', async () => {
  const wallets = Array.from({ length: 1001 }, (_, i) => address(i + 1));
  const late = wallets.at(-1)!;
  const state = setup({ wallets, target: '100', rotation: wallets.at(-2),
    priorStats: wallets.map(address => ({ address, settled_count: 9, failed_count: 1, last_block: address === late ? 5 : 100 })) });
  const rpc = sparse(101, new Map([[90, [ok(late)]]]));
  expect((await managed({ transport: rpc })).complete).toBe(true);
  expect(rpc.calls).toEqual([[90]]);
  expect(state.statsUpserted.at(-1)).toEqual(expect.objectContaining({ address: late, settled_count: 10, failed_count: 1, last_block: 100 }));
});

test('production sparse transport sends archive block quantities and restores reordered receipt batches', async () => {
  const requests: Array<Array<{ jsonrpc: string; id: number; method: string; params: unknown[] }>> = [];
  track(spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const result = body[0].method === 'eth_getTransactionCount'
      ? [{ id: 0, result: '0x2' }]
      : [{ id: 1, result: [failed(W1)] }, { id: 0, result: [ok(W1)] }];
    return Response.json(result);
  }) as typeof fetch));
  const rpc = createArcMainnetWalkTransport('https://rpc.example');
  expect(await rpc.getNonce!(W1, 255)).toBe('0x2');
  expect(requests[0]).toEqual([{ jsonrpc: '2.0', id: 0, method: 'eth_getTransactionCount', params: [W1, '0xff'] }]);
  expect(await rpc.fetchReceipts([1, 2])).toEqual([[ok(W1)], [failed(W1)]]);
});

test.each(['missing', 'duplicate', 'error', 'short'])('production receipt transport rejects %s response ids or entries', async kind => {
  const rows = kind === 'missing' ? [{ id: 0, result: [] }, { id: 2, result: [] }]
    : kind === 'duplicate' ? [{ id: 0, result: [] }, { id: 0, result: [] }]
    : kind === 'error' ? [{ id: 0, result: [] }, { id: 1, error: { message: 'rpc failed' } }]
    : [{ id: 0, result: [] }];
  track(spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(rows)));
  await expect(createArcMainnetWalkTransport('https://rpc.example').fetchReceipts([1, 2])).rejects.toThrow();
});

test('production nonce transport rejects a mismatched response id', async () => {
  track(spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([{ id: 7, result: '0x2' }])));
  await expect(createArcMainnetWalkTransport('https://rpc.example').getNonce!(W1, 255)).rejects.toThrow('arc_walk_eth_getTransactionCount_unavailable');
});


test('invalid sparse work budget rejects before any database or RPC calls', async () => {
  const state = setup({ wallets: [W1] });
  const rpc = sparse(101, new Map());
  await expect(managed({ transport: rpc, maxBlocks: 0 })).rejects.toThrow('arc_mainnet_walk_invalid');
  expect(rpc.calls).toEqual([]);
  expect(state.saveCursor).not.toHaveBeenCalled();
});

test('sparse first wallet publishes its verified success before spending a second genesis turn', async () => {
  const state = setup({ wallets: [W1, W2] });
  const rpc = sparse(101, new Map([[80, [ok(W1)]]]));
  expect((await managed({ transport: rpc, maxBlocks: 2 })).complete).toBe(false);
  expect(rpc.calls).toEqual([[0], [80]]);
  expect(state.rateWrites.some(row => row.__address === W1 && row.metric_success_rate === 1)).toBe(true);
  expect(state.statsUpserted.some(row => row.address === W2)).toBe(false);
});

test('sparse shares validated genesis receipts across wallets while preserving each outgoing outcome', async () => {
  const state = setup({ wallets: [W1, W2] });
  const rpc = sparse(101, new Map([[0, [ok(W1), failed(W2)]]]));
  const result = await managed({ transport: rpc });
  expect(result.complete).toBe(true);
  expect(result.scanned).toBe(1);
  expect(rpc.calls).toEqual([[0]]);
  expect(state.statsUpserted).toEqual([
    expect.objectContaining({ address: W1, settled_count: 1, failed_count: 0, last_block: 100 }),
    expect.objectContaining({ address: W2, settled_count: 0, failed_count: 1, last_block: 100 }),
  ]);
});

test('sparse banks verified genesis when a later nonce read fails and resumes without recounting it', async () => {
  const initial = setup({ wallets: [W1] });
  const receipts = new Map([[0, [ok(W1)]], [80, [failed(W1)]]]);
  const broken = { ...sparse(101, receipts), getNonce: async () => { throw new Error('archive_down'); } };
  expect((await managed({ transport: broken, retryAttempts: 0 })).complete).toBe(false);
  const committed = initial.statsUpserted.at(-1) as unknown as StatsRow;
  expect(committed).toEqual(expect.objectContaining({ last_block: 0, settled_count: 1, failed_count: 0 }));
  expect(initial.rateWrites.at(-1)?.metric_success_rate).toBeNull();
  const restarted = setup({ wallets: [W1], target: '100', priorStats: [committed] });
  const rpc = sparse(101, receipts);
  expect((await managed({ transport: rpc })).complete).toBe(true);
  expect(rpc.calls).toEqual([[80]]);
  expect(restarted.statsUpserted.at(-1)).toEqual(expect.objectContaining({ last_block: 100, settled_count: 1, failed_count: 1 }));
});

test('sparse genesis continuation preserves one non-genesis candidate per wallet turn', async () => {
  const state = setup({ wallets: [W1, W2] });
  const rpc = sparse(101, new Map([[10, [ok(W1)]], [20, [ok(W1)]], [15, [failed(W2)]]]));
  const result = await managed({ transport: rpc, maxBlocks: 3 });
  expect(result.scanned).toBe(3);
  expect(result.complete).toBe(false);
  expect(rpc.calls).toEqual([[0], [10], [15]]);
  expect(state.statsUpserted.at(-1)).toEqual(expect.objectContaining({ address: W2, failed_count: 1, last_block: 100 }));
});

test('sparse never caches malformed genesis evidence for the next wallet', async () => {
  const state = setup({ wallets: [W1, W2] });
  let calls = 0;
  const rpc = { ...sparse(101, new Map()), fetchReceipts: async () => {
    calls++;
    return calls === 1 ? [[r(W1, '0x2')]] : [[]];
  } };
  expect((await managed({ transport: rpc, retryAttempts: 0 })).complete).toBe(false);
  expect(calls).toBe(2);
  expect(state.statsUpserted).toEqual([expect.objectContaining({ address: W2, settled_count: 0, failed_count: 0, last_block: 100 })]);
});
