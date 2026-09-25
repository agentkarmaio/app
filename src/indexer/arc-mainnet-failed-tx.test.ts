import { afterEach, expect, setSystemTime, spyOn, test } from 'bun:test';
import * as db from '@/db/client';
import { runWithIndexingContext } from '@/db/indexing-context';
import { isExplorerChallenge, sweepArcMainnetFailedTxs } from './arc-mainnet-failed-tx';
import type { ExplorerPage } from './arc-mainnet-failed-tx';

const address = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;
const now = new Date('2026-09-25T12:00:00Z');
const restores: Array<() => void> = [];
afterEach(() => { restores.splice(0).reverse().forEach(restore => restore()); db.__setSupabaseForTest(null); setSystemTime(); });
function track<T extends { mockRestore(): void }>(spy: T): T { restores.push(() => spy.mockRestore()); return spy; }

function explorerItem(from: string, status: string) {
  return { hash: `0x${Math.random().toString(16).slice(2).padStart(64, '0')}`, from: { hash: from }, status };
}

function explorerFeed(wallets: Map<string, ExplorerPage[]>) {
  const pagesSeen: string[] = [];
  const calls: string[] = [];
  const fetchJson = async (url: string): Promise<ExplorerPage> => {
    calls.push(url);
    const match = url.match(/addresses\/(0x[0-9a-f]{40})\//);
    if (!match) throw new Error(`unexpected url ${url}`);
    const queue = wallets.get(match[1]);
    if (!queue || queue.length === 0) throw new Error(`unexpected fetch for ${match[1]}`);
    pagesSeen.push(match[1]);
    return queue.shift()!;
  };
  return { fetchJson, calls, pagesSeen };
}

function setup(wallets: string[], cursor: string, updated: Array<Record<string, unknown>> = []) {
  setSystemTime(now);
  db.__setSupabaseForTest({ from(table: string) {
    expect(table).toBe('wallets');
    let after = '';
    let limit = 1000;
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.update = (row: Record<string, unknown>) => {
      updated.push(row);
      const u: Record<string, unknown> = {};
      u.eq = (column: string, value: string) => {
        if (column === 'address') (row as { __address?: string }).__address = value;
        return u;
      };
      u.then = (resolve: (value: unknown) => void) => resolve({ error: null });
      return u;
    };
    b.eq = (column: string, value: string) => {
      if (column === 'chain') expect(value).toBe('arc-mainnet');
      return b;
    };
    b.gt = (column: string, value: string) => { expect(column).toBe('address'); after = value; return b; };
    b.order = (column: string, opts: { ascending: boolean }) => { expect(column).toBe('address'); expect(opts.ascending).toBe(true); return b; };
    b.limit = (limitValue: number) => { limit = limitValue; return b; };
    b.then = (resolve: (value: unknown) => void) => resolve({
      data: wallets.filter(a => a > after).slice(0, limit).map(address => ({ address })),
      error: null,
    });
    return b;
  } });
  track(spyOn(db, 'getCursor').mockImplementation(async (key, chain) => {
    expect(chain).toBe('arc-mainnet');
    expect(key).toBe('arc-mainnet-failed-tx');
    return { chain: 'arc-mainnet', facilitator: key, last_signature: cursor, last_slot: null, updated_at: now.toISOString() };
  }));
  const saveCursor = track(spyOn(db, 'upsertCursor').mockImplementation(async (key, _value, _slot, chain) => {
    expect(key).toBe('arc-mainnet-failed-tx');
    expect(chain).toBe('arc-mainnet');
    return undefined;
  }));
  return { saveCursor, updated };
}

const managed = (opts: Parameters<typeof sweepArcMainnetFailedTxs>[0] = {}) => runWithIndexingContext({
  chain: 'arc-mainnet', path: 'transfers', owner: 'test-owner', signal: opts?.signal,
}, () => sweepArcMainnetFailedTxs(opts));

test('persists the measured outgoing success rate and advances per wallet', async () => {
  const wallets = [address(1), address(2)];
  const updated: Array<Record<string, unknown>> = [];
  const state = setup(wallets, '', updated);
  const feed = new Map<string, ExplorerPage[]>([
    // 7 settled + 3 failed outgoing across two pages, plus incoming noise.
    [address(1), [
      { items: [explorerItem(address(1), 'ok'), explorerItem(address(1), 'ok'), explorerItem(address(1), 'error'),
        explorerItem(address(2), 'ok')], next_page_params: { block_number: 1 } },
      { items: [explorerItem(address(1), 'ok'), explorerItem(address(1), 'ok'), explorerItem(address(1), 'ok'),
        explorerItem(address(1), 'ok'), explorerItem(address(1), 'ok'), explorerItem(address(1), 'error'),
        explorerItem(address(1), 'error'), explorerItem(address(2), 'ok')], next_page_params: null },
    ]],
    // Blind read: explorer knows no outgoing activity → no write, cursor advances.
    [address(2), [{ items: [explorerItem(address(1), 'ok')], next_page_params: null }]],
  ]);
  const transport = explorerFeed(feed);
  const result = await managed({ fetchJson: transport.fetchJson });
  expect(result).toMatchObject({ swept: 2, complete: true, cursor: '', challenged: false });
  expect(updated).toEqual([
    expect.objectContaining({ metric_success_rate: 0.7, __address: address(1) }),
  ]);
  // Targeted update only: the sweep must never touch score columns.
  expect(Object.keys(updated[0]).sort()).toEqual(['__address', 'metric_success_rate']);
  expect(state.saveCursor).toHaveBeenCalledTimes(2);
});

test('a challenge stops the run without advancing past the affected wallet', async () => {
  const wallets = [address(1), address(2)];
  const updated: Array<Record<string, unknown>> = [];
  setup(wallets, '', updated);
  const feed = new Map<string, ExplorerPage[]>([
    [address(1), [{ items: [explorerItem(address(1), 'ok'), explorerItem(address(1), 'error')], next_page_params: null }]],
    [address(2), [{ items: [], next_page_params: null }]],
  ]);
  const transport = explorerFeed(feed);
  const fetchJson = async (url: string) => {
    if (url.includes(address(2))) throw challenge();
    return transport.fetchJson(url);
  };
  const result = await managed({ fetchJson, maxPageRetries: 2 });
  expect(result).toMatchObject({ swept: 1, complete: false, cursor: address(1), challenged: true });
  expect(isExplorerChallenge(challenge())).toBe(true);
  expect(updated).toHaveLength(1);
});

test('a transient challenge is retried within the page budget', async () => {
  const wallets = [address(1)];
  const updated: Array<Record<string, unknown>> = [];
  setup(wallets, '', updated);
  const feed = new Map<string, ExplorerPage[]>([
    [address(1), [{ items: [explorerItem(address(1), 'ok'), explorerItem(address(1), 'ok'), explorerItem(address(1), 'error')], next_page_params: null }]],
  ]);
  const transport = explorerFeed(feed);
  let challengedOnce = false;
  const fetchJson = async (url: string) => {
    if (!challengedOnce) { challengedOnce = true; throw challenge(); }
    return transport.fetchJson(url);
  };
  const result = await managed({ fetchJson, maxPageRetries: 2 });
  expect(result).toMatchObject({ swept: 1, complete: true, challenged: false });
  expect(updated[0]).toMatchObject({ metric_success_rate: 2 / 3, __address: address(1) });
});

test('no wallet evidence and exhausted rotation complete cleanly', async () => {
  const updated: Array<Record<string, unknown>> = [];
  setup([], '', updated);
  const result = await managed({ fetchJson: async () => ({ items: [], next_page_params: null }) });
  expect(result).toMatchObject({ swept: 0, complete: true, cursor: '', challenged: false });
});

function challenge(): Error {
  const error = new Error('explorer_challenged') as Error & { code: string };
  error.code = 'explorer_challenged';
  return error;
}