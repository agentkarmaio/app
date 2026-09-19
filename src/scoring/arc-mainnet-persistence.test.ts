import { afterEach, expect, spyOn, test, setSystemTime } from 'bun:test';
import * as db from '@/db/client';
import type { SignalEvent } from '@/db/schema';
import { markIndexingLeaseLost, runWithIndexingContext } from '@/db/indexing-context';
import { ARC_MAINNET_TRANSFER_EMITTER } from '@/config/arc-mainnet';
import { computeAgentLiveBundle } from './live-agent-score';
import { refreshArcMainnetScores } from './arc-mainnet-persistence';

const address = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;
const wallet = address(1);
const now = new Date('2026-09-19T12:00:00Z');
const restores: Array<() => void> = [];
afterEach(() => { restores.splice(0).reverse().forEach(restore => restore()); db.__setSupabaseForTest(null); setSystemTime(); });
function track<T extends { mockRestore(): void }>(spy: T): T { restores.push(() => spy.mockRestore()); return spy; }
function receipt(face: 'provider' | 'consumer', index = 1): SignalEvent {
  const hash = `0x${index.toString(16).padStart(64, '0')}`;
  return { id: String(index), chain: 'arc-mainnet', agent_wallet: wallet,
    kind: 'usdc_transfer_settled', tier: 2, face, weight: 0.6, value: 1,
    tx_ref: `${hash}:0`, signed_by: null, observed_at: now.toISOString(), created_at: now.toISOString(),
    payload: { source: 'arc_native_usdc_transfer', rawTxHash: hash, logIndex: 0,
      rawAmount: '1000000000000000000', amountDecimal: '1', amount: 1, decimals: 18,
      emitter: ARC_MAINNET_TRANSFER_EMITTER, counterparty: address(2) } };
}
function setup(addresses = [wallet], events: SignalEvent[] = []) {
  setSystemTime(now);
  let cursor = '';
  const pages: { chain?: string; after?: string; limit?: number }[] = [];
  db.__setSupabaseForTest({ from(table: string) {
    expect(table).toBe('wallets');
    const page: typeof pages[number] = {};
    pages.push(page);
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (column: string, value: string) => { expect(column).toBe('chain'); page.chain = value; return b; };
    b.gt = (column: string, value: string) => { expect(column).toBe('address'); page.after = value; return b; };
    b.order = (column: string, opts: { ascending: boolean }) => { expect(column).toBe('address'); expect(opts.ascending).toBe(true); return b; };
    b.limit = (limit: number) => { expect(limit).toBeLessThanOrEqual(1000); page.limit = limit; return b; };
    b.then = (resolve: (value: unknown) => void) => resolve({ data: addresses.filter(a => a > (page.after ?? '')).slice(0, page.limit).map(address => ({ address })), error: null });
    return b;
  } });
  track(spyOn(db, 'getCursor').mockImplementation(async (_key, chain) => {
    expect(chain).toBe('arc-mainnet');
    return { chain: 'arc-mainnet', facilitator: 'arc-mainnet-score-refresh', last_signature: cursor, last_slot: null, updated_at: now.toISOString() };
  }));
  const saveCursor = track(spyOn(db, 'upsertCursor').mockImplementation(async (key, value, _slot, chain) => {
    expect(key).toBe('arc-mainnet-score-refresh'); expect(chain).toBe('arc-mainnet'); cursor = value;
  }));
  const read = track(spyOn(db, 'getArcMainnetReceiptEvents').mockResolvedValue({ events, saturated: false }));
  const write = track(spyOn(db, 'upsertWallet').mockResolvedValue(undefined));
  return { pages, read, write, saveCursor, cursor: () => cursor };
}
const managed = (opts: Parameters<typeof refreshArcMainnetScores>[0] = {}) => runWithIndexingContext({
  chain: 'arc-mainnet', path: 'transfers', owner: 'test-owner', signal: opts?.signal,
}, () => refreshArcMainnetScores(opts));

test.each(['provider', 'consumer'] as const)('persists shared %s face model without legacy metrics or cross-chain writes', async face => {
  const state = setup([wallet], [receipt(face), receipt(face)]);
  const bundle = await computeAgentLiveBundle(wallet, 'arc-mainnet');
  expect(await managed()).toMatchObject({ scored: 1, complete: true });
  expect(state.write).toHaveBeenCalledWith(wallet, bundle.receiptScore!.provider.score, 'Unrated', 1, {
    providerScore: bundle.receiptScore!.provider.score,
    consumerScore: face === 'consumer' ? bundle.receiptScore!.consumer.score : null,
    confidenceBadge: bundle.receiptScore!.provider.confidenceBadge,
    lastSeen: now.toISOString(), autonomyScore: bundle.autonomy?.score ?? null, autonomyLabel: bundle.autonomy?.label ?? null,
    metricSuccessRate: null, metricDiversity: null, metricVolume: null, metricAge: null, metricCadence: null,
  }, 'arc-mainnet');
  expect(state.pages.every(p => p.chain === 'arc-mainnet')).toBe(true);
});
test('reciprocal evidence and then empty evidence clear stale ranking without fabricating activity', async () => {
  const state = setup([wallet], [receipt('provider'), receipt('consumer', 2)]);
  await managed();
  expect(state.write.mock.calls[0].slice(1, 4)).toEqual([0, 'Unrated', 2]);
  state.read.mockResolvedValue({ events: [], saturated: false });
  await managed();
  expect(state.write.mock.calls[1]).toMatchObject({ 1: 0, 3: 0, 4: { lastSeen: null, consumerScore: null } });
});
test('decay refresh runs again without new receipts and preserves observed last activity', async () => {
  const state = setup([wallet], [receipt('provider')]);
  await managed();
  setSystemTime(new Date(now.getTime() + 180 * 86400000));
  await managed();
  expect(state.write.mock.calls[1][1]).toBeLessThan(state.write.mock.calls[0][1]);
  expect(state.write.mock.calls[1][4]?.lastSeen).toBe(now.toISOString());
});
test('bounded cycles resume beyond 1000 wallets and wrap for subsequent decay refresh', async () => {
  const addresses = Array.from({ length: 1002 }, (_, i) => address(i + 1));
  const state = setup(addresses);
  expect(await managed({ maxWallets: 1000 })).toMatchObject({ scored: 1000, complete: false });
  expect(state.cursor()).toBe(address(1000));
  expect(await managed()).toMatchObject({ scored: 2, complete: true });
  expect(state.cursor()).toBe('');
  expect(state.write.mock.calls.map(call => call[0])).toEqual(addresses);
});
test('evidence failure does not overwrite a score or advance its durable cursor', async () => {
  const state = setup(); state.read.mockRejectedValue(new Error('evidence unavailable'));
  await expect(managed()).rejects.toThrow('evidence unavailable');
  expect(state.write).not.toHaveBeenCalled(); expect(state.saveCursor).not.toHaveBeenCalled();
});
test('lease rejection prevents advancing past a rejected score write', async () => {
  const state = setup(); state.write.mockRejectedValue(new Error('indexing_lease_lost'));
  await expect(managed()).rejects.toThrow('indexing_lease_lost');
  expect(state.saveCursor).not.toHaveBeenCalled();
});
test('lease loss during evidence reads prevents subsequent score and cursor writes', async () => {
  const state = setup();
  state.read.mockImplementation(async () => { markIndexingLeaseLost(); return { events: [], saturated: false }; });
  await expect(managed()).rejects.toThrow('indexing_lease_lost');
  expect(state.write).not.toHaveBeenCalled(); expect(state.saveCursor).not.toHaveBeenCalled();
});
test('time budget saves completed progress and resumes instead of repeating the first wallets', async () => {
  const state = setup(Array.from({ length: 9 }, (_, i) => address(i + 1)));
  let elapsed = 0;
  track(spyOn(performance, 'now').mockImplementation(() => elapsed));
  state.write.mockImplementation(async () => { elapsed = 40_000; });
  expect(await managed()).toMatchObject({ scored: 4, complete: false, cursor: address(4) });
  expect(state.cursor()).toBe(address(4));
  state.write.mockResolvedValue(undefined);
  expect(await managed()).toMatchObject({ scored: 5, complete: true, cursor: '' });
  expect(state.write.mock.calls.map(call => call[0])).toEqual(Array.from({ length: 9 }, (_, i) => address(i + 1)));
});
test('requires transfer ownership and checks abort before DB access', async () => {
  const state = setup();
  await expect(refreshArcMainnetScores()).rejects.toThrow('arc_mainnet_lease_required');
  const controller = new AbortController(); controller.abort();
  await expect(managed({ signal: controller.signal })).rejects.toThrow();
  expect(state.pages).toHaveLength(0); expect(state.write).not.toHaveBeenCalled();
});
