import { afterEach, expect, test } from 'bun:test';
import { __setSupabaseForTest, type InsertSignalEventInput } from '@/db/client';
import { arcMainnetTransfersIndexer, parseArcMainnetTransfer } from '@/indexer/arc-mainnet-transfers';
import { ARC_MAINNET_TRANSFER_EMITTER } from '@/config/arc-mainnet';
import { resolveKarma } from '@/lib/karma-resolver';
import { GET as scoreGET } from './v2/score/[wallet]/route';
import { GET as badgeGET } from './badge/[wallet]/route';

const sender = `0x${'1'.repeat(40)}`;
const receiver = `0x${'2'.repeat(40)}`;
afterEach(() => __setSupabaseForTest(null));

async function installIndexedEvidence(subject = receiver) {
  const events: InsertSignalEventInput[] = [];
  await arcMainnetTransfersIndexer({
    getChainId: async () => 5042,
    loadSeedRows: async () => ({ registryRows: [{ chain: 'arc-mainnet', owner: receiver }], walletRows: [] }),
    getHead: async () => 10n, getCursor: async () => null,
    getLogs: async () => [0, 1].map(logIndex => parseArcMainnetTransfer({
      address: ARC_MAINNET_TRANSFER_EMITTER,
      args: { from: sender, to: receiver, value: 10n ** 18n },
      blockNumber: 10n, transactionHash: `0x${'a'.repeat(64)}`, logIndex, removed: false,
    })!),
    blockTimestamp: async () => new Date(Date.now() - 60_000).toISOString(),
    ensureWallets: async () => {}, insertTransactions: async rows => rows.length,
    insertSignalEvents: async rows => { events.push(...rows); return rows.length; },
    upsertCursor: async () => {},
  });
  const reads: string[] = [];
  __setSupabaseForTest({ from(table: string) {
    const filters: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    for (const method of ['select', 'order', 'limit', 'range', 'in', 'or', 'gte', 'lte', 'gt', 'lt', 'is', 'not']) b[method] = () => b;
    b.eq = (key: string, value: unknown) => { filters[key] = value; reads.push(`${table}.${key}=${value}`); return b; };
    const rows = () => table === 'signal_events' && filters.chain === 'arc-mainnet'
      ? events.filter(e => e.agentWallet === subject).map((e, i) => ({ ...e, id: String(i), agent_wallet: e.agentWallet, tx_ref: e.txRef, observed_at: e.observedAt, signed_by: e.signedBy ?? null, created_at: new Date().toISOString() }))
      : [];
    b.single = async () => ({ data: null, error: { code: 'PGRST116' } });
    b.maybeSingle = async () => ({ data: null, error: null });
    b.then = (resolve: (r: unknown) => void) => resolve({ data: rows(), error: null });
    return b;
  } });
  return reads;
}

test('mainnet receiver-only evidence uses one behavior snapshot in API and badge', async () => {
  await installIndexedEvidence();
  const params = { params: Promise.resolve({ wallet: receiver }) };
  const api = await scoreGET(new Request(`http://localhost/api/v2/score/${receiver}?chain=arc-mainnet`) as never, params);
  expect(api.status).toBe(200);
  const body = await api.json();
  const shared = await resolveKarma(receiver, 'arc-mainnet');
  expect(shared).not.toBeNull();
  expect(body.provider.score).toBeGreaterThan(0);
  expect(body.provider.score).toBe(shared!.provider.score);
  expect(body.provider.confidenceBadge).toBe('behavior-inferred');
  expect(body.consumer.hasSignal).toBe(false);
  expect(body.consumer.score).toBeNull();
  expect(body.txCount).toBe(1);
  expect(body.receiptEvidence.model).toBe('arc-mainnet-transfers-v1');
  expect(body.receiptEvidence.received).toBe(2);
  const badge = await badgeGET(new Request(`http://localhost/api/badge/${receiver}?chain=arc-mainnet&format=json`) as never, params);
  expect(badge.status).toBe(200);
  const badgeBody = await badge.json();
  expect(badgeBody.chain).toBe('arc-mainnet');
  expect(badgeBody.providerScore).toBe(body.provider.score);
  expect(badgeBody.consumerScore).toBeNull();
  expect(badgeBody.confidenceBadge).toBe(body.provider.confidenceBadge);
  expect(badgeBody.txCount).toBe(1);
});


test('mainnet sender-only face selection preserves missing provider evidence', async () => {
  await installIndexedEvidence(sender);
  const params = { params: Promise.resolve({ wallet: sender }) };
  const api = await scoreGET(new Request(`http://localhost/api/v2/score/${sender}?chain=arc-mainnet&face=consumer`) as never, params);
  expect(api.status).toBe(200);
  const body = await api.json();
  expect(body.provider).toBeUndefined();
  expect(body.consumer.hasSignal).toBe(true);
  expect(body.consumer.score).toBeGreaterThan(0);
  expect(body.consumer.confidenceBadge).toBe('behavior-inferred');
  expect(body.txCount).toBe(1);
  expect(body.autonomy).toHaveProperty('score');
});


test('sender-only mainnet badge never presents missing provider evidence as an assessed zero', async () => {
  await installIndexedEvidence(sender);
  const params = { params: Promise.resolve({ wallet: sender }) };
  const json = await badgeGET(new Request(`http://localhost/api/badge/${sender}?chain=arc-mainnet&format=json`) as never, params);
  expect(json.status).toBe(200);
  const body = await json.json();
  expect(body.score).toBeNull();
  expect(body.providerScore).toBeNull();
  expect(body.provider.score).toBeNull();
  expect(body.consumerScore).toBeGreaterThan(0);
  const svg = await badgeGET(new Request(`http://localhost/api/badge/${sender}?chain=arc-mainnet`) as never, params);
  expect(svg.status).toBe(200);
  const markup = await svg.text();
  expect(markup).toContain('Unrated');
  expect(markup).not.toContain('>0.0</text>');
});
