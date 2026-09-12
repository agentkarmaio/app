import { afterEach, describe, expect, test } from 'bun:test';
import * as db from './client';
import type { Chain } from './schema';
import { isChain } from './schema';

afterEach(() => db.__setSupabaseForTest(null));
const mainnet = 'arc-mainnet' as Chain;
const wallet = '0x1111111111111111111111111111111111111111';
const hash = '0x' + 'ab'.repeat(32);
function captureClient() {
  const reads: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const writes: Array<{ table: string; rows: unknown; options: unknown }> = [];
  db.__setSupabaseForTest({ from(table: string) {
    const entry = { table, filters: [] as Array<[string, unknown]> }; reads.push(entry);
    const result = { data: [], error: null, count: 0 };
    const builder = {
      select: () => builder,
      eq: (key: string, value: unknown) => { entry.filters.push([key, value]); return builder; },
      in: () => builder, order: () => builder, range: () => builder, limit: () => builder, gte: () => builder,
      single: async () => ({ data: null, error: { code: 'PGRST116' } }),
      then: (resolve: (value: typeof result) => void) => Promise.resolve(resolve(result)),
      upsert: (rows: unknown, options: unknown) => { writes.push({ table, rows, options }); return builder; },
      insert: (rows: unknown) => { writes.push({ table, rows, options: null }); return builder; },
    };
    return builder;
  } });
  return { reads, writes };
}

describe('network-scoped database surface', () => {
  test('Arc testnet and mainnet are independent accepted chain identities', () => {
    expect(isChain('arc')).toBe(true);
    expect(isChain('arc-mainnet')).toBe(true);
  });

  const calls: Array<[string, (chain?: Chain) => Promise<unknown>]> = [
    ['transactions', chain => db.getTransactions(wallet, 10, 0, chain)],
    ['transaction count', chain => db.getTransactionCount(wallet, chain)],
    ['recent transactions', chain => db.getRecentTransactionsForWallet(wallet, 10, chain)],
    ['batch transactions', chain => db.getTransactionsForWallets([wallet], 10, chain)],
    ['transaction signature', chain => db.getTransactionBySig(hash, chain)],
    ['score history', chain => db.getScoreHistory(wallet, 10, chain)],
    ['batch score histories', chain => db.getScoreHistoriesForWallets([wallet], 30, 10, chain)],
    ['signals', chain => db.getSignalEventsForWallet(wallet, 10, chain)],
    ['batch signals', chain => db.getSignalEventsForWallets([wallet], chain)],
    ['latest signals', chain => db.getLatestSignalValues([wallet], 'payment', chain)],
    ['signal counts', chain => db.countSignalEventsByKind([wallet], 'payment', chain)],
    ['feedback', chain => db.getFeedbackForAgent(wallet, 10, chain)],
    ['feedback summary', chain => db.getFeedbackSummary(wallet, chain)],
    ['feedback ratings', chain => db.getFeedbackRatingsForSignatures([hash], chain)],
    ['batch feedback summaries', chain => db.getFeedbackSummariesForWallets([wallet], chain)],
  ];
  for (const [name, call] of calls) {
    test(`${name} filters explicit network and defaults legacy calls to Solana`, async () => {
      for (const chain of [mainnet, 'arc' as Chain, undefined]) {
        const { reads } = captureClient();
        await call(chain);
        expect(reads.length).toBeGreaterThan(0);
        for (const read of reads) expect(read.filters).toContainEqual(['chain', chain ?? 'solana']);
      }
    });
  }

  test('single and batch writes keep raw hashes and deduplicate within the network', async () => {
    const { writes } = captureClient();
    const tx: db.TransactionInsert = { chain: mainnet, wallet_address: wallet, facilitator: wallet, tx_signature: hash, timestamp: '2026-09-12T00:00:00Z', success: true, amount: '0.000000000000000001' };
    await db.insertTransaction(tx);
    await db.insertTransactions([tx, { ...tx, chain: 'arc' }]);
    for (const write of writes) expect(write.options).toEqual({ onConflict: 'chain,tx_signature', ignoreDuplicates: true });
    expect((writes[0].rows as Record<string, unknown>).tx_signature).toBe(hash);
    expect((writes[0].rows as Record<string, unknown>).amount).toBe('0.000000000000000001');
    expect((writes[1].rows as Array<Record<string, unknown>>).map(row => row.chain)).toEqual(['arc-mainnet', 'arc']);
  });

  test('legacy feedback duplicate lookup and write remain explicitly Solana-only', async () => {
    const { reads, writes } = captureClient();
    await db.hasFeedbackForTx(hash);
    expect(reads[0].filters).toContainEqual(['chain', 'solana']);
    await db.insertFeedback(wallet, wallet, 'delivered', hash);
    expect(writes[0].rows).toMatchObject({ chain: 'solana' });
  });
});
