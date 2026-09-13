/**
 * Arc mainnet USDC receipts. Only the native system emitter is indexed:
 * https://docs.arc.io/arc/references/usdc-system-events.md
 * It covers native and ERC-20 movements at 18 decimals from genesis; reading
 * the ERC-20 emitter too would count the same movement twice. Gas is not logged.
 * Receipt identities are rawTxHash:logIndex; raw identities remain in signals.
 */
import { createPublicClient, formatUnits, http } from 'viem';
import { arcMainnet } from '@/config/arc-chain';
import {
  ARC_MAINNET_CHAIN_ID, ARC_MAINNET_USDC_CONTRACT, ARC_MAINNET_TRANSFER_EMITTER,
  ARC_MAINNET_TRANSFER_DECIMALS, ARC_MAINNET_TRANSFER_EXCLUSIONS, ARC_MAINNET_SEED_EXTRA,
  ARC_MAINNET_MAX_SEED_SIZE, parseArcMainnetRpcUrl, parseArcMainnetStartBlock, parseArcMainnetSeedAddresses,
} from '@/config/arc-mainnet';
import {
  supabase, insertTransactions, insertSignalEvents, makeEnsureWallets,
  getCursor, upsertCursor,
} from '@/db/client';
import { getIndexingHeaders } from '@/db/indexing-context';
import { isRateLimitedError } from '@/lib/rpc-retry';
import { arcTransfersIndexer, TRANSFER_EVENT, type ArcTransfer, type ArcTransfersIndexerDeps } from './arc-transfers';
import { isArcLogRangeError, withArcLogRetry, type ArcIndexRunResult } from './arc-log-range';

interface MainnetTransferLog {
  address: string;
  args: { from?: unknown; to?: unknown; value?: unknown };
  blockNumber: bigint | null;
  transactionHash: string | null;
  logIndex: number | null;
  removed?: boolean;
}
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

export function parseArcMainnetTransfer(log: MainnetTransferLog): ArcTransfer | null {
  if (log.address.toLowerCase() !== ARC_MAINNET_TRANSFER_EMITTER) return null;
  const { from, to, value } = log.args;
  if (typeof from !== 'string' || !ADDRESS.test(from) || typeof to !== 'string' || !ADDRESS.test(to)
    || typeof value !== 'bigint' || value <= 0n || value >= 10n ** 38n
    || typeof log.blockNumber !== 'bigint' || log.blockNumber < 0n || !log.transactionHash || !HASH.test(log.transactionHash)
    || !Number.isSafeInteger(log.logIndex) || log.logIndex! < 0 || log.removed) throw new Error('arc_mainnet_transfer_invalid');
  const amountDecimal = formatUnits(value, ARC_MAINNET_TRANSFER_DECIMALS);
  return {
    from: from.toLowerCase() as `0x${string}`, to: to.toLowerCase() as `0x${string}`,
    rawAmount: value, amount: Number(amountDecimal), amountDecimal,
    blockNumber: log.blockNumber, txHash: log.transactionHash.toLowerCase() as `0x${string}`,
    logIndex: log.logIndex!, emitter: ARC_MAINNET_TRANSFER_EMITTER, decimals: ARC_MAINNET_TRANSFER_DECIMALS,
  };
}

export interface ArcMainnetSeedRows {
  registryRows: ReadonlyArray<{ chain: string; owner?: string | null; agent_wallet?: string | null }>;
  walletRows: ReadonlyArray<{ chain: string; address?: string | null; claimed?: boolean | null; arc_agent_id?: number | null }>;
  extra?: readonly string[];
}

export function buildArcMainnetSeedSet(rows: ArcMainnetSeedRows): Set<string> {
  const seed = new Set<string>();
  const add = (address: string | null | undefined) => {
    if (!address || !ADDRESS.test(address)) return;
    const normalized = address.toLowerCase();
    if (!ARC_MAINNET_TRANSFER_EXCLUSIONS.has(normalized)) seed.add(normalized);
    if (seed.size > ARC_MAINNET_MAX_SEED_SIZE) throw new Error('arc_mainnet_seed_limit');
  };
  for (const row of rows.registryRows) {
    if (row.chain !== 'arc-mainnet') continue;
    add(row.owner); add(row.agent_wallet);
  }
  for (const row of rows.walletRows) {
    if (row.chain === 'arc-mainnet' && row.claimed === true) add(row.address);
  }
  for (const address of rows.extra ?? ARC_MAINNET_SEED_EXTRA) add(address);
  return seed;
}

/** Ordered, paged, independent membership; no testnet arc_agent_id predicate. */
export async function loadArcMainnetSeedRows(signal?: AbortSignal): Promise<ArcMainnetSeedRows> {
  async function read<T>(table: 'erc8004_agents' | 'wallets', columns: string, order: string): Promise<T[]> {
    const rows: T[] = [];
    // Bound source rows too: duplicate owners must not turn a seed read unbounded.
    for (let offset = 0; offset <= ARC_MAINNET_MAX_SEED_SIZE; offset += 1000) {
      signal?.throwIfAborted();
      let query = supabase.from(table).select(columns).eq('chain', 'arc-mainnet');
      if (table === 'wallets') query = query.eq('claimed', true);
      const { data, error } = await query.order(order, { ascending: true }).range(offset, offset + 999);
      signal?.throwIfAborted();
      if (error) throw error;
      const page = (data ?? []) as T[];
      rows.push(...page);
      if (rows.length > ARC_MAINNET_MAX_SEED_SIZE) throw new Error('arc_mainnet_seed_limit');
      if (page.length < 1000) return rows;
    }
    throw new Error('arc_mainnet_seed_limit');
  }
  const registryRows = await read<ArcMainnetSeedRows['registryRows'][number]>('erc8004_agents', 'chain,owner,agent_wallet', 'agent_id');
  const walletRows = await read<ArcMainnetSeedRows['walletRows'][number]>('wallets', 'chain,address,claimed', 'address');
  return { registryRows, walletRows, extra: parseArcMainnetSeedAddresses(process.env.ARC_MAINNET_SEED_ADDRESSES) };
}

export interface ArcMainnetTransfersDeps extends Omit<ArcTransfersIndexerDeps, 'chain' | 'seed' | 'usdcContract'> {
  getChainId: () => Promise<number>;
  loadSeedRows: () => Promise<ArcMainnetSeedRows>;
}

function safeMainnetError(error: unknown): Error {
  if (error instanceof Error && /^arc_mainnet_[a-z_]+$/.test(error.message)) return error;
  if (isArcLogRangeError(error)) return new Error('rpc_range_rejected');
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const record = current as { status?: unknown; statusCode?: unknown; message?: unknown; details?: unknown; cause?: unknown };
    const message = [record.message, record.details].filter((value) => typeof value === 'string').join(' ');
    if (record.status === 401 || record.status === 403 || record.statusCode === 401 || record.statusCode === 403 || /\b(?:401|403)\b|unauthorized|forbidden/i.test(message)) return new Error('rpc_authentication_failed');
    current = record.cause;
  }
  if (isRateLimitedError(error)) return new Error('rpc_rate_limited');
  return new Error('rpc_unavailable');
}

/** Offline-testable admission seam. No event or cursor reads precede chain identity. */
export async function arcMainnetTransfersIndexer(deps: ArcMainnetTransfersDeps): Promise<ArcIndexRunResult> {
  try {
    deps.signal?.throwIfAborted();
    const chainId = await deps.getChainId();
    deps.signal?.throwIfAborted();
    if (chainId !== ARC_MAINNET_CHAIN_ID) throw new Error('arc_mainnet_chain_mismatch');
    const rows = await deps.loadSeedRows();
    deps.signal?.throwIfAborted();
    return await arcTransfersIndexer({
      ...deps, chain: 'arc-mainnet', usdcContract: ARC_MAINNET_USDC_CONTRACT,
      seed: buildArcMainnetSeedSet(rows),
    });
  } catch (error) {
    deps.signal?.throwIfAborted();
    throw safeMainnetError(error);
  }
}

/** Production writes are admitted only by the managed mainnet/transfers lease. */
export async function runArcMainnetTransfersIndexer(opts: { signal?: AbortSignal; maxWindows?: number } = {}): Promise<ArcIndexRunResult> {
  opts.signal?.throwIfAborted();
  const context = getIndexingHeaders();
  if (context['x-indexing-chain'] !== 'arc-mainnet' || context['x-indexing-path'] !== 'transfers' || !context['x-indexing-owner']) throw new Error('arc_mainnet_lease_required');
  const rpcUrl = parseArcMainnetRpcUrl(process.env.ARC_MAINNET_RPC_URL);
  const startBlock = parseArcMainnetStartBlock(process.env.ARC_MAINNET_TRANSFERS_START_BLOCK);
  const client = createPublicClient({ chain: arcMainnet, transport: http(rpcUrl, { retryCount: 0, timeout: 15_000 }) });
  const rpc = async <T>(read: () => Promise<T>): Promise<T> => {
    const result = await withArcLogRetry(() => { opts.signal?.throwIfAborted(); return read(); });
    opts.signal?.throwIfAborted();
    return result;
  };
  let seedList: `0x${string}`[] = [];
  return arcMainnetTransfersIndexer({
    signal: opts.signal, windowSize: 10_000, maxWindows: opts.maxWindows ?? 50, timeBudgetMs: 120_000,
    getChainId: () => rpc(() => client.getChainId()),
    loadSeedRows: async () => {
      const rows = await loadArcMainnetSeedRows(opts.signal);
      seedList = [...buildArcMainnetSeedSet(rows)] as `0x${string}`[];
      return rows;
    },
    getHead: () => rpc(() => client.getBlockNumber()),
    getLogs: async (fromBlock, toBlock, face) => {
      if (seedList.length === 0) throw new Error('arc_mainnet_seed_empty');
      const logs = await rpc(() => client.getLogs({
        address: ARC_MAINNET_TRANSFER_EMITTER, event: TRANSFER_EVENT,
        args: face === 'from' ? { from: seedList } : { to: seedList }, fromBlock, toBlock,
      }));
      const transfers: ArcTransfer[] = [];
      for (const log of logs) {
        const transfer = parseArcMainnetTransfer(log);
        if (transfer) transfers.push(transfer);
      }
      return transfers;
    },
    blockTimestamp: async (blockNumber) => {
      const block = await rpc(() => client.getBlock({ blockNumber }));
      return new Date(Number(block.timestamp) * 1000).toISOString();
    },
    ensureWallets: makeEnsureWallets('arc-mainnet'), insertTransactions, insertSignalEvents,
    getCursor: async (key) => {
      const cursor = await getCursor(key, 'arc-mainnet');
      return cursor ?? { last_signature: String(startBlock - 1), last_slot: startBlock - 1 };
    },
    upsertCursor: async (key, last, slot) => upsertCursor(key, last, slot, 'arc-mainnet'),
  });
}
