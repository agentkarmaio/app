import { afterEach, expect, spyOn, test } from 'bun:test';
import * as db from '@/db/client';
import { markIndexingLeaseLost, runWithIndexingContext } from '@/db/indexing-context';
import { refreshStellarDisplayMetrics } from './stellar-display-metrics';

const restores: Array<() => void> = [];
afterEach(() => { restores.splice(0).reverse().forEach((r) => r()); });
function track<T extends { mockRestore(): void }>(spy: T): T { restores.push(() => spy.mockRestore()); return spy; }

const PROVIDER = 'GPROVIDER';
const SIBLING = 'GSIBLING';
const tx = (sig: string, from: string, to: string | null, timestamp = '2026-08-17T00:00:00Z') =>
  ({ tx_signature: sig, wallet_address: from, counterparty: to, timestamp });
const wallet = (address: string, over: Partial<db.StellarWalletDisplayRow> = {}): db.StellarWalletDisplayRow =>
  ({ address, tx_count: 0, last_seen: null, metric_diversity: null, metric_success_rate: null, ...over });

function setup(opts: {
  rows: ReturnType<typeof tx>[];
  wallets: db.StellarWalletDisplayRow[];
  owners?: Array<{ owner: string; agent_wallet: string | null }>;
}) {
  track(spyOn(db, 'getStellarReceiptRows').mockResolvedValue(opts.rows));
  track(spyOn(db, 'getStellarRegistryOwners').mockResolvedValue(opts.owners ?? []));
  track(spyOn(db, 'getStellarWalletDisplayRows').mockResolvedValue(opts.wallets));
  const writes = track(spyOn(db, 'updateStellarDisplayMetrics').mockResolvedValue(undefined));
  // The scorer must never be reached from this path: it writes Karma/tier/badge.
  const upsert = track(spyOn(db, 'upsertWallet').mockResolvedValue(undefined));
  const markDirty = track(spyOn(db, 'markWalletsDirty').mockResolvedValue(undefined));
  return { writes, upsert, markDirty };
}

const managed = <T>(fn: () => Promise<T>, signal?: AbortSignal) => runWithIndexingContext(
  { chain: 'stellar', path: 'transfers', owner: 'test-owner', signal }, fn,
);

test('an inbound-only provider gets Txs / Active / Diversity (the 2026-11-19 gap)', async () => {
  const s = setup({
    rows: [tx('t1', 'GPAYER1', PROVIDER, '2026-08-01T00:00:00Z'), tx('t2', 'GPAYER2', PROVIDER, '2026-08-05T00:00:00Z')],
    wallets: [wallet(PROVIDER)],
  });
  const r = await managed(() => refreshStellarDisplayMetrics());
  expect(s.writes).toHaveBeenCalledWith(PROVIDER, {
    tx_count: 2, last_seen: '2026-08-05T00:00:00.000Z', metric_diversity: 0.2, metric_success_rate: null,
  });
  expect(r.updated).toBeGreaterThanOrEqual(1);
});

test('writes display columns only: never the Karma path, never the rescore queue', async () => {
  const s = setup({ rows: [tx('t1', 'GPAYER', PROVIDER)], wallets: [wallet(PROVIDER), wallet('GPAYER')] });
  await managed(() => refreshStellarDisplayMetrics());
  expect(s.upsert).not.toHaveBeenCalled();
  expect(s.markDirty).not.toHaveBeenCalled();
  for (const [, patch] of s.writes.mock.calls) {
    expect(Object.keys(patch).sort()).toEqual(['last_seen', 'metric_diversity', 'metric_success_rate', 'tx_count']);
  }
});

test('catches up a payer whose newest row was never rescored (Agent Intern 7 vs 6)', async () => {
  const rows = Array.from({ length: 7 }, (_, i) => tx(`t${i}`, PROVIDER, `GPAYEE${i}`, `2026-08-${10 + i}T00:00:00Z`));
  const s = setup({ rows, wallets: [wallet(PROVIDER, { tx_count: 6, last_seen: '2026-08-15T00:00:00+00:00', metric_diversity: '0.5000', metric_success_rate: '1.0000' })] });
  await managed(() => refreshStellarDisplayMetrics());
  expect(s.writes).toHaveBeenCalledWith(PROVIDER, {
    tx_count: 7, last_seen: '2026-08-16T00:00:00.000Z', metric_diversity: 0.7, metric_success_rate: null,
  });
});

test('skips rows whose values already match (DB numeric strings + offset timestamps)', async () => {
  const s = setup({
    rows: [tx('t1', 'GPAYER', PROVIDER, '2026-08-17T00:00:00Z')],
    wallets: [wallet(PROVIDER, { tx_count: 1, last_seen: '2026-08-17T00:00:00+00:00', metric_diversity: '0.1000' })],
  });
  const r = await managed(() => refreshStellarDisplayMetrics());
  expect(s.writes.mock.calls.find(([a]) => a === PROVIDER)).toBeUndefined();
  expect(r.updated).toBe(0);
});

test('same-owner transfers do not count', async () => {
  const s = setup({
    rows: [tx('t1', SIBLING, PROVIDER), tx('t2', 'GCUSTOMER', PROVIDER)],
    wallets: [wallet(PROVIDER)],
    owners: [{ owner: SIBLING, agent_wallet: null }, { owner: SIBLING, agent_wallet: PROVIDER }],
  });
  await managed(() => refreshStellarDisplayMetrics());
  expect(s.writes).toHaveBeenCalledWith(PROVIDER, expect.objectContaining({ tx_count: 1, metric_diversity: 0.1 }));
});

test('a wallet with no activity and default columns is left untouched', async () => {
  const s = setup({ rows: [], wallets: [wallet('GQUIET')] });
  const r = await managed(() => refreshStellarDisplayMetrics());
  expect(s.writes).not.toHaveBeenCalled();
  expect(r).toEqual({ wallets: 1, updated: 0 });
});

test('refuses to run outside the stellar/transfers lease', async () => {
  setup({ rows: [], wallets: [] });
  await expect(refreshStellarDisplayMetrics()).rejects.toThrow();
});

test('stops writing once the lease is lost', async () => {
  const s = setup({ rows: [tx('t1', 'GP', PROVIDER)], wallets: [wallet(PROVIDER)] });
  await expect(managed(async () => { markIndexingLeaseLost(); return refreshStellarDisplayMetrics(); })).rejects.toThrow();
  expect(s.writes).not.toHaveBeenCalled();
});
