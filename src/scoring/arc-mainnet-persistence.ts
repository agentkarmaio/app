import { getCursor, supabase, upsertCursor, upsertWallet } from '@/db/client';
import { getIndexingHeaders } from '@/db/indexing-context';
import { computeAgentLiveBundle } from './live-agent-score';

const CURSOR_KEY = 'arc-mainnet-score-refresh';
const ADDRESS = /^0x[0-9a-f]{40}$/;
const CONCURRENCY = 4;

export interface ArcMainnetRefreshOptions {
  signal?: AbortSignal;
  batchSize?: number;
  maxWallets?: number;
  timeBudgetMs?: number;
}
export interface ArcMainnetRefreshResult {
  scored: number;
  complete: boolean;
  cursor: string;
}

/** Persist the same bounded receipt model used by profiles and APIs. A durable
 * address cursor rotates through inactive wallets too, so decay keeps running
 * without new transfers. Score writes and cursor writes share the transfer
 * lease's database fence; an interrupted batch is safely recomputed. */
export async function refreshArcMainnetScores(
  options: ArcMainnetRefreshOptions = {},
): Promise<ArcMainnetRefreshResult> {
  const { signal, batchSize = 100, maxWallets = 200, timeBudgetMs = 40_000 } = options;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000
    || !Number.isSafeInteger(maxWallets) || maxWallets < 1 || maxWallets > 10_000
    || !Number.isFinite(timeBudgetMs) || timeBudgetMs <= 0 || timeBudgetMs > 40_000) {
    throw new Error('arc_mainnet_score_refresh_invalid');
  }
  function assertLease() {
    signal?.throwIfAborted();
    const context = getIndexingHeaders();
    if (context['x-indexing-chain'] !== 'arc-mainnet'
      || context['x-indexing-path'] !== 'transfers' || !context['x-indexing-owner']) {
      throw new Error('arc_mainnet_lease_required');
    }
  }
  assertLease();
  const started = performance.now();
  let cursor = (await getCursor(CURSOR_KEY, 'arc-mainnet'))?.last_signature ?? '';
  if (cursor !== '' && !ADDRESS.test(cursor)) throw new Error('arc_mainnet_score_cursor_invalid');
  let scored = 0;
  while (scored < maxWallets && performance.now() - started < timeBudgetMs) {
    assertLease();
    const take = Math.min(batchSize, maxWallets - scored);
    let query = supabase.from('wallets').select('address')
      .eq('chain', 'arc-mainnet').order('address', { ascending: true }).limit(take);
    if (cursor) query = query.gt('address', cursor);
    const { data, error } = await query;
    if (error) throw error;
    const rows = (data ?? []) as Array<{ address: string }>;
    // Reject malformed or non-increasing keys before updating any wallet.
    let previous = cursor;
    for (const row of rows) {
      if (!ADDRESS.test(row.address) || row.address <= previous) throw new Error('arc_mainnet_score_cursor_invalid');
      previous = row.address;
    }
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      if (performance.now() - started >= timeBudgetMs) return { scored, complete: false, cursor };
      assertLease();
      const group = rows.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(group.map(async ({ address }) => {
        const bundle = await computeAgentLiveBundle(address, 'arc-mainnet');
        assertLease();
        const receipt = bundle.receiptScore!;
        await upsertWallet(address, receipt.provider.score, receipt.provider.trustTier, receipt.txCount, {
          providerScore: receipt.provider.score,
          consumerScore: receipt.consumer.hasSignal ? receipt.consumer.score : null,
          confidenceBadge: receipt.provider.confidenceBadge,
          lastSeen: receipt.lastActive,
          autonomyScore: bundle.autonomy?.score ?? null,
          autonomyLabel: bundle.autonomy?.label ?? null,
          // The legacy payment metrics do not describe native transfer evidence.
          metricSuccessRate: null, metricDiversity: null, metricVolume: null,
          metricAge: null, metricCadence: null,
        }, 'arc-mainnet');
      }));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      assertLease();
      cursor = group[group.length - 1].address;
      await upsertCursor(CURSOR_KEY, cursor, undefined, 'arc-mainnet');
      scored += group.length;
    }
    if (rows.length < take) {
      assertLease();
      await upsertCursor(CURSOR_KEY, '', undefined, 'arc-mainnet');
      return { scored, complete: true, cursor: '' };
    }
  }
  return { scored, complete: false, cursor };
}
