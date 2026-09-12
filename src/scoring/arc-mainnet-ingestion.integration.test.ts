import { afterEach, expect, test } from 'bun:test';
import type { SignalEvent } from '@/db/schema';
import { __setSupabaseForTest, type InsertSignalEventInput, type TransactionInsert } from '@/db/client';
import { ARC_MAINNET_TRANSFER_EMITTER } from '@/config/arc-mainnet';
import { arcMainnetTransfersIndexer, parseArcMainnetTransfer } from '@/indexer/arc-mainnet-transfers';
import { collectArcMainnetReceipts } from './arc-mainnet-receipts';
import { computeAgentLiveBundle } from './live-agent-score';
import { resolveKarma } from '@/lib/karma-resolver';
import { resolveAgentCardFields } from '@/lib/agent-card-fields';
import { fullKarmaJson, resolveForChain } from '@/app/mcp/route';
import { ArcMainnetAgentProfile } from '@/components/karma/arc-mainnet-agent-profile';
import { renderToStaticMarkup } from 'react-dom/server';

afterEach(() => __setSupabaseForTest(null));

test('the real mainnet parser and ingestion engine emit both scoreable behavior faces with lossless identity', async () => {
  const sender = `0x${'1'.repeat(40)}`;
  const receiver = `0x${'2'.repeat(40)}`;
  const hash = `0x${'a'.repeat(64)}`;
  const timestamp = '2026-09-12T00:00:00.000Z';
  const signals: InsertSignalEventInput[] = [];
  const transactions: TransactionInsert[] = [];
  const ensured = new Set<string>();
  const transfer = parseArcMainnetTransfer({
    address: ARC_MAINNET_TRANSFER_EMITTER,
    args: { from: sender, to: receiver, value: 1000000000000000001n },
    blockNumber: 10n, transactionHash: hash, logIndex: 7,
  })!;
  await arcMainnetTransfersIndexer({
    getChainId: async () => 5042,
    loadSeedRows: async () => ({ registryRows: [], walletRows: [{ chain: 'arc-mainnet', address: receiver, claimed: true }] }),
    getHead: async () => 10n,
    getCursor: async () => null,
    getLogs: async () => [transfer],
    blockTimestamp: async () => timestamp,
    ensureWallets: async wallets => { wallets.forEach(wallet => ensured.add(wallet)); },
    insertTransactions: async rows => { transactions.push(...rows); return rows.length; },
    insertSignalEvents: async rows => { signals.push(...rows); return rows.length; },
    upsertCursor: async () => {},
  });
  expect(ensured).toEqual(new Set([sender, receiver]));
  expect(transactions).toHaveLength(1);
  expect(transactions[0]).toMatchObject({ chain: 'arc-mainnet', wallet_address: sender,
    tx_signature: `${hash}:7`, amount: '1.000000000000000001' });
  const rows: SignalEvent[] = signals.map((row, index) => ({
    id: String(index), chain: row.chain!, agent_wallet: row.agentWallet,
    kind: row.kind, tier: row.tier, face: row.face ?? 'provider', weight: row.weight ?? 1, value: row.value ?? null,
    payload: row.payload ?? null, signed_by: row.signedBy ?? null, tx_ref: row.txRef ?? null,
    observed_at: new Date(row.observedAt!).toISOString(), created_at: timestamp,
  }));
  for (const [wallet, face] of [[sender, 'consumer'], [receiver, 'provider']] as const) {
    const result = collectArcMainnetReceipts(wallet, rows.filter(row => row.agent_wallet === wallet));
    expect(result.invalid).toBe(0);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ face, rawTxHash: hash, logIndex: 7,
      eventKey: `${hash}:7`, rawAmount: '1000000000000000001', amountDecimal: '1.000000000000000001' });
  }

  // Persist the ACTUAL engine output into a chain-filtered in-memory read seam.
  // A matching testnet address has a high stored score and must never leak.
  const wallets = [sender, receiver].flatMap(address => [
    { address, chain: 'arc', provider_score: 99, consumer_score: 99, tx_count: 900, trust_tier: 'Excellent', claimed: false },
    { address, chain: 'arc-mainnet', provider_score: 0, consumer_score: null, tx_count: 0, trust_tier: 'Unrated', claimed: false },
  ]);
  const reads: Array<{ table: string; filters: Record<string, unknown>; limit?: number; range?: [number, number] }> = [];
  let signalError = false;
  __setSupabaseForTest({ from(table: string) {
    const read: { table: string; filters: Record<string, unknown>; limit?: number; range?: [number, number] } = { table, filters: {} };
    reads.push(read);
    const b: Record<string, unknown> = {};
    for (const method of ['select', 'order', 'in', 'or', 'gte', 'lte', 'is', 'not']) b[method] = () => b;
    b.eq = (key: string, value: unknown) => { read.filters[key] = value; return b; };
    b.range = (from: number, to: number) => { read.range = [from, to]; return b; };
    b.limit = (limit: number) => { read.limit = limit; return b; };
    const result = () => {
      const source = table === 'wallets' ? wallets : table === 'signal_events' ? rows : [];
      const data = source.filter(row => Object.entries(read.filters).every(([key, value]) => (row as Record<string, unknown>)[key] === value));
      return { data: data.slice(read.range?.[0] ?? 0, read.range ? read.range[1] + 1 : read.limit), error: table === 'signal_events' && signalError ? { message: 'evidence unavailable' } : null };
    };
    b.single = b.maybeSingle = async () => ({ ...result(), data: result().data[0] ?? null });
    b.then = (resolve: (value: unknown) => void) => resolve(result());
    return b;
  } });
  const snapshot = await resolveKarma(receiver, 'arc-mainnet');
  const bundle = await computeAgentLiveBundle(receiver, 'arc-mainnet');
  const card = await resolveAgentCardFields(receiver, { chain: 'arc-mainnet' });
  const resolved = await resolveForChain(receiver, 'arc-mainnet');
  const mcp = fullKarmaJson(resolved!, receiver);
  expect(snapshot!.provider).toMatchObject({ score: 5.06, confidenceBadge: 'behavior-inferred', hasSignal: true });
  expect(snapshot!.consumer.hasSignal).toBe(false);
  expect(bundle.receiptScore!.provider.score).toBe(snapshot!.provider.score);
  expect(card.score).toBe(snapshot!.provider.score);
  expect(mcp).toMatchObject({ chain: 'arc-mainnet', provider: { score: 5.06 }, consumer: { score: null },
    receiptEvidence: { model: 'arc-mainnet-transfers-v1', received: 1, sent: 0, matchedReciprocalRawAmount: '0' } });
  expect(reads.filter(read => read.table === 'signal_events').every(read => read.filters.chain === 'arc-mainnet' && read.range?.[1] === 999)).toBe(true);
  const html = renderToStaticMarkup(await ArcMainnetAgentProfile({ wallet: receiver }));
  expect(html).toContain('Received');
  expect(html).toContain('1.000000000000000001 USDC');
  expect(html).toContain('5.1');
  expect(html).not.toContain('99.0');
  signalError = true;
  await expect(resolveKarma(receiver, 'arc-mainnet')).rejects.toMatchObject({ message: 'evidence unavailable' });
  await expect(computeAgentLiveBundle(receiver, 'arc-mainnet')).rejects.toMatchObject({ message: 'evidence unavailable' });
  await expect(resolveAgentCardFields(receiver, { chain: 'arc-mainnet' })).rejects.toMatchObject({ message: 'evidence unavailable' });
});
