import { getCursor, supabase, upsertCursor } from '@/db/client';
import { getIndexingHeaders } from '@/db/indexing-context';
import { ARC_MAINNET_CHAIN_ID, parseArcMainnetRpcUrl, parseArcMainnetStartBlock } from '@/config/arc-mainnet';

const CURSOR_KEY = 'arc-mainnet-block-walk';
const UPDATE_CONCURRENCY = 4;
const STATS_CHUNK = 1000;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const DECIMAL = /^\d+$/;

/** One block's receipts, reduced to the fields settlement attribution needs. */
export interface WalkReceipt { from?: string; status?: string }

/** Chain transport seam. The production implementation speaks batched JSON-RPC
 * (`eth_getBlockReceipts`, one call per block); tests feed synthetic batches. */
export interface WalkChainTransport {
  getChainId: () => Promise<string>;
  getHead: () => Promise<string>;
  fetchReceipts: (blocks: number[]) => Promise<WalkReceipt[][]>;
}

export interface ArcMainnetWalkOptions {
  signal?: AbortSignal;
  transport?: WalkChainTransport;
  rpcUrl?: string;
  /** Chain height where the walk begins when no cursor exists (the transfer
   * stream's start block). Required in production via the shared repo variable. */
  startBlock?: number;
  batchSize?: number;
  concurrency?: number;
  timeBudgetMs?: number;
  maxBlocks?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
}
export interface ArcMainnetWalkResult {
  scanned: number;
  walletsUpdated: number;
  complete: boolean;
  cursor: string;
}
interface WalletStats { address: string; settled_count: number; failed_count: number; last_block: number }

/**
 * All-time per-wallet settlement counters from block receipts. Every outgoing
 * receipt (from = wallet) is settled (`0x1`) or failed (`0x0`); the ratio lands
 * in `wallets.metric_success_rate` via targeted update only — a reverted tx can
 * never emit a Transfer event, so this evidence is invisible to the transfer
 * stream. Counters persist per wallet with a block high-water mark, so a run
 * that dies between stats commit and cursor advance is recounted without
 * double-counting. The walk runs only under the managed arc-mainnet/transfers
 * lease; RPC throttling stops the run resumably and never pages the job, while
 * lease/config/DB faults throw.
 */
export async function walkArcMainnetSettlement(
  options: ArcMainnetWalkOptions = {},
): Promise<ArcMainnetWalkResult> {
  const { signal } = options;
  const batchSize = options.batchSize ?? 100;
  const concurrency = options.concurrency ?? 3;
  const timeBudgetMs = options.timeBudgetMs ?? 30_000;
  const maxBlocks = options.maxBlocks ?? 60_000;
  const retryAttempts = options.retryAttempts ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 250;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500
    || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 10
    || !Number.isFinite(timeBudgetMs) || timeBudgetMs <= 0 || timeBudgetMs > 40_000
    || !Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 500_000
    || !Number.isSafeInteger(retryAttempts) || retryAttempts < 0 || retryAttempts > 5
    || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 5_000) {
    throw new Error('arc_mainnet_walk_invalid');
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
  const retry = async <T>(read: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        signal?.throwIfAborted();
        return await read();
      } catch (error) {
        if (attempt >= retryAttempts || signal?.aborted) throw error;
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
  };
  const resumableStop = (cursor: string): ArcMainnetWalkResult =>
    ({ scanned: 0, walletsUpdated: 0, complete: false, cursor });

  const transport = options.transport
    ?? createArcMainnetWalkTransport(
      parseArcMainnetRpcUrl(options.rpcUrl ?? process.env.ARC_MAINNET_RPC_URL), signal);
  const chainId = await safeRpc(retry, transport.getChainId);
  if (chainId === undefined) return resumableStop('');
  if (parseInt(chainId, 16) !== ARC_MAINNET_CHAIN_ID) throw new Error('arc_mainnet_chain_mismatch');

  const stored = await getCursor(CURSOR_KEY, 'arc-mainnet');
  const cursor = stored?.last_signature ?? '';
  if (cursor !== '' && !DECIMAL.test(cursor)) throw new Error('arc_mainnet_walk_cursor_invalid');
  let next: number;
  if (cursor !== '') {
    next = Number(cursor) + 1;
  } else {
    const startBlock = options.startBlock
      ?? parseArcMainnetStartBlock(process.env.ARC_MAINNET_TRANSFERS_START_BLOCK);
    if (!Number.isSafeInteger(startBlock) || startBlock <= 0) throw new Error('arc_mainnet_walk_start_missing');
    next = startBlock;
  }
  const firstUnscanned = next;

  const { data: walletRows, error: walletError } = await supabase.from('wallets')
    .select('address').eq('chain', 'arc-mainnet');
  if (walletError) throw walletError;
  const walletSet = new Set(((walletRows ?? []) as Array<{ address: string }>)
    .map(row => row.address.toLowerCase()));
  // No wallet subjects: nothing to measure and nothing to resume, ever.
  if (walletSet.size === 0) return { scanned: 0, walletsUpdated: 0, complete: true, cursor };

  const prior = new Map<string, WalletStats>();
  const { data: statsRows, error: statsError } = await supabase.from('wallet_tx_stats')
    .select('address,settled_count,failed_count,last_block').eq('chain', 'arc-mainnet');
  if (statsError) throw statsError;
  for (const row of (statsRows ?? []) as Array<Partial<WalletStats>>) {
    if (typeof row.address === 'string' && ADDRESS.test(row.address)
      && Number.isSafeInteger(row.settled_count) && Number.isSafeInteger(row.failed_count)
      && Number.isSafeInteger(row.last_block)) {
      prior.set(row.address, row as WalletStats);
    }
  }

  const headHex = await safeRpc(retry, transport.getHead);
  if (headHex === undefined) return resumableStop(cursor);
  const target = parseInt(headHex, 16) - 1; // never the tip: its receipts can still change
  const absoluteCap = firstUnscanned + maxBlocks - 1;

  const deltas = new Map<string, { settled: number; failed: number }>();
  let lastScanned = firstUnscanned - 1;
  let stopped = false;
  while (next <= target && next <= absoluteCap && performance.now() - started < timeBudgetMs) {
    signal?.throwIfAborted();
    assertLease();
    const walkTarget = Math.min(target, absoluteCap);
    const batchCount = Math.min(concurrency, Math.ceil((walkTarget - next + 1) / batchSize));
    const settledBatch = await Promise.allSettled(
      Array.from({ length: batchCount }, (_, k) => {
        const from = next + k * batchSize;
        const to = Math.min(walkTarget, from + batchSize - 1);
        return retry(() => transport.fetchReceipts(range(from, to)));
      }),
    );
    let usable = 0;
    for (const batch of settledBatch) {
      if (batch.status !== 'fulfilled') break;
      usable++;
    }
    if (usable < batchCount) stopped = true;
    for (let k = 0; k < usable; k++) {
      const receipts = (settledBatch[k] as PromiseFulfilledResult<WalkReceipt[][]>).value;
      for (const blockReceipts of receipts) {
        lastScanned++;
        for (const receipt of blockReceipts ?? []) {
          const from = receipt.from?.toLowerCase();
          if (!from || !walletSet.has(from)) continue;
          const counted = prior.get(from);
          if (counted && lastScanned <= counted.last_block) continue;
          const delta = deltas.get(from) ?? { settled: 0, failed: 0 };
          if (receipt.status === '0x1') delta.settled++;
          else if (receipt.status === '0x0') delta.failed++;
          else continue;
          deltas.set(from, delta);
        }
      }
    }
    next = lastScanned + 1;
    if (stopped) break;
  }

  const touched = [...deltas.keys()];
  let walletsUpdated = 0;
  if (touched.length > 0) {
    const nowIso = new Date().toISOString();
    const rows = touched.map(addr => {
      const counted = prior.get(addr);
      const delta = deltas.get(addr)!;
      return {
        chain: 'arc-mainnet',
        address: addr,
        settled_count: (counted?.settled_count ?? 0) + delta.settled,
        failed_count: (counted?.failed_count ?? 0) + delta.failed,
        last_block: Math.max(counted?.last_block ?? 0, lastScanned),
        updated_at: nowIso,
      };
    });
    for (let i = 0; i < rows.length; i += STATS_CHUNK) {
      const { error } = await supabase.from('wallet_tx_stats')
        .upsert(rows.slice(i, i + STATS_CHUNK), { onConflict: 'chain,address' });
      if (error) throw error;
    }
    // Rates re-derive from persisted counters; the walk never upserts wallets.
    const rateRows = rows.filter(row => row.settled_count + row.failed_count > 0);
    for (let i = 0; i < rateRows.length; i += UPDATE_CONCURRENCY) {
      signal?.throwIfAborted();
      await Promise.all(rateRows.slice(i, i + UPDATE_CONCURRENCY).map(async row => {
        const { error } = await supabase.from('wallets')
          .update({ metric_success_rate: row.settled_count / (row.settled_count + row.failed_count) })
          .eq('chain', 'arc-mainnet').eq('address', row.address);
        if (error) throw error;
      }));
    }
    walletsUpdated = rateRows.length;
  }
  if (lastScanned > firstUnscanned - 1) {
    await upsertCursor(CURSOR_KEY, String(lastScanned), lastScanned, 'arc-mainnet');
  }
  return {
    scanned: Math.max(0, lastScanned - (firstUnscanned - 1)),
    walletsUpdated,
    complete: !stopped && lastScanned >= target,
    cursor: String(lastScanned),
  };
}

/** An RPC hiccup is a resumable stop, never a page: bounded retries, then the
 * run gives up its slot for the next lease rotation. */
async function safeRpc<T>(
  retry: (read: () => Promise<T>) => Promise<T>,
  read: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await retry(read);
  } catch {
    return undefined;
  }
}

function range(from: number, to: number): number[] {
  const blocks: number[] = [];
  for (let block = from; block <= to; block++) blocks.push(block);
  return blocks;
}

/** Production transport: batched JSON-RPC against the Arc mainnet endpoint.
 * Each request carries one `eth_getBlockReceipts` per block; entries map by id
 * so ordering never depends on the node's batch response order. */
export function createArcMainnetWalkTransport(
  rpcUrl: string,
  signal?: AbortSignal,
): WalkChainTransport {
  const rpcPost = async (body: unknown) => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`arc_walk_http_${res.status}`);
    return await res.json() as Array<{ id: number; result?: unknown; error?: { message?: string } }>;
  };
  const single = async (method: string): Promise<string> => {
    const rows = await rpcPost([{ jsonrpc: '2.0', id: 0, method, params: [] }]);
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].error
      || typeof rows[0].result !== 'string') {
      throw new Error(`arc_walk_${method}_unavailable`);
    }
    return rows[0].result;
  };
  return {
    getChainId: () => single('eth_chainId'),
    getHead: () => single('eth_blockNumber'),
    fetchReceipts: async (blocks: number[]) => {
      const rows = await rpcPost(blocks.map((block, id) => ({
        jsonrpc: '2.0', id, method: 'eth_getBlockReceipts',
        params: [`0x${block.toString(16)}`],
      })));
      if (!Array.isArray(rows) || rows.length !== blocks.length) {
        throw new Error('arc_walk_batch_malformed');
      }
      const byId = new Map(rows.map(row => [row.id, row]));
      return blocks.map((_, id) => {
        const row = byId.get(id);
        if (!row || row.error || !Array.isArray(row.result)) {
          throw new Error('arc_walk_receipt_unavailable');
        }
        return row.result as WalkReceipt[];
      });
    },
  };
}