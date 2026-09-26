/**
 * Arc USDC receipts. Only the native system emitter is indexed:
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
import { arcTransfersIndexer, arcTransfersCursorKey, TRANSFER_EVENT, type ArcTransfer, type ArcTransfersIndexerDeps, type TransferFace } from './arc-transfers';
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
  /** Production coverage store. A global stream cursor cannot prove when an
   * address joined the seed set; only these per-address frontiers can. */
  history?: ArcMainnetSeedHistory;
}

export interface ArcMainnetSeedHistory {
  read: (seeds: ReadonlySet<string>) => Promise<Map<string, number>>;
  write: (rows: Array<{ address: string; block: number }>) => Promise<void>;
  getLogs: (from: bigint, to: bigint, face: TransferFace, seeds: ReadonlySet<string>) => Promise<ArcTransfer[]>;
}

const SEED_CURSOR_PREFIX = 'arc-mainnet-transfer-seed:';
// Cursor keys include a prefix as well as the address. 200 encoded keys make
// a 14.7KB URI; Kong's cap is 8KB (see db/client.ts ADDRESS_IN_CHUNK).
const SEED_CURSOR_READ_BATCH = 75;
const SEED_CURSOR_WRITE_BATCH = 200;

/** Batched membership reads avoid one DB round trip per registry address and
 * stay below PostgREST's response cap. Removed seeds keep their saved history. */
export async function readArcMainnetSeedCoverage(seeds: ReadonlySet<string>, signal?: AbortSignal): Promise<Map<string, number>> {
  const addresses = [...seeds];
  const result = new Map<string, number>();
  for (let offset = 0; offset < addresses.length; offset += SEED_CURSOR_READ_BATCH) {
    signal?.throwIfAborted();
    const { data, error } = await supabase.from('indexer_cursors')
      .select('facilitator,last_slot').eq('chain', 'arc-mainnet')
      .in('facilitator', addresses.slice(offset, offset + SEED_CURSOR_READ_BATCH).map(address => SEED_CURSOR_PREFIX + address));
    signal?.throwIfAborted();
    if (error) throw error;
    for (const row of data ?? []) {
      const address = row.facilitator.slice(SEED_CURSOR_PREFIX.length);
      if (!seeds.has(address) || !Number.isSafeInteger(row.last_slot) || row.last_slot < 0) {
        throw new Error('arc_mainnet_seed_cursor_invalid');
      }
      result.set(address, row.last_slot);
    }
  }
  return result;
}

export async function writeArcMainnetSeedCoverage(rows: Array<{ address: string; block: number }>, signal?: AbortSignal): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += SEED_CURSOR_WRITE_BATCH) {
    signal?.throwIfAborted();
    const { error } = await supabase.from('indexer_cursors').upsert(
      rows.slice(offset, offset + SEED_CURSOR_WRITE_BATCH).map(row => ({
        chain: 'arc-mainnet', facilitator: SEED_CURSOR_PREFIX + row.address,
        last_signature: String(row.block), last_slot: row.block, updated_at: new Date().toISOString(),
      })), { onConflict: 'chain,facilitator' });
    signal?.throwIfAborted();
    if (error) throw error;
  }
}

/** Live windows run first, reserving half the budget for membership recovery.
 * Resume the most advanced incomplete cohort before admitting new seeds, so
 * registrations during recovery cannot continually reset that cohort to zero. */
async function scanWithSeedHistory(deps: ArcMainnetTransfersDeps, seeds: ReadonlySet<string>): Promise<ArcIndexRunResult> {
  const history = deps.history!;
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.timeBudgetMs ?? 120_000);
  // Registered agents with only failed/non-USDC transactions have no transfer
  // row to create them. Materialize the admitted seed subjects so settlement
  // can inspect them too; the shared helper inserts identities only, preserving
  // existing metrics and never claiming activity that was not observed.
  await deps.ensureWallets([...seeds]);
  deps.signal?.throwIfAborted();
  const coverage = await history.read(seeds);
  deps.signal?.throwIfAborted();
  for (const [address, block] of coverage) {
    if (!seeds.has(address) || !Number.isSafeInteger(block) || block < 0) throw new Error('arc_mainnet_seed_cursor_invalid');
  }
  const globalKey = arcTransfersCursorKey(ARC_MAINNET_USDC_CONTRACT, 'arc-mainnet');
  const previous = await deps.getCursor(globalKey);
  const previousBlock = previous?.last_slot ?? -1;
  if (!Number.isSafeInteger(previousBlock) || previousBlock < -1) throw new Error('arc_mainnet_seed_cursor_invalid');
  deps.signal?.throwIfAborted();
  const live = await arcTransfersIndexer({
    ...deps, chain: 'arc-mainnet', usdcContract: ARC_MAINNET_USDC_CONTRACT, seed: seeds,
    getCursor: async () => previous ?? { last_signature: '-1', last_slot: -1 },
    timeBudgetMs: Math.max(0, (deadline - now()) / 2),
  });
  if (live.coverage.reason === 'head_behind_cursor') return live;
  const liveBlock = Number(live.coverage.checkpoint ?? previousBlock);
  const head = Number(live.coverage.head);
  if (!Number.isSafeInteger(head) || head < 0 || !Number.isSafeInteger(liveBlock)
    || liveBlock < -1 || liveBlock > head) throw new Error('arc_mainnet_seed_cursor_invalid');
  if ([...coverage.values()].some(block => block > head)) throw new Error('arc_mainnet_seed_cursor_invalid');
  // A seed is continuous only if its prior verified prefix reaches the start
  // of this live scan. Missing seeds never inherit an existing stream cursor.
  const continuous = [...seeds].filter(address => (coverage.get(address) ?? -1) >= previousBlock);
  if (liveBlock >= 0 && liveBlock > previousBlock && continuous.length > 0) {
    await history.write(continuous.filter(address => (coverage.get(address) ?? -1) < liveBlock)
      .map(address => ({ address, block: liveBlock })));
    deps.signal?.throwIfAborted();
    for (const address of continuous) coverage.set(address, Math.max(coverage.get(address) ?? -1, liveBlock));
  }

  const pending = [...seeds].filter(address => (coverage.get(address) ?? -1) < liveBlock);
  let replay: ArcIndexRunResult | undefined;
  if (pending.length > 0 && now() < deadline) {
    const frontier = Math.max(...pending.map(address => coverage.get(address) ?? -1));
    const cohort = new Set(pending.filter(address => (coverage.get(address) ?? -1) === frontier));
    replay = await arcTransfersIndexer({
      ...deps, chain: 'arc-mainnet', usdcContract: ARC_MAINNET_USDC_CONTRACT, seed: cohort,
      getHead: async () => BigInt(liveBlock),
      getCursor: async () => ({ last_signature: String(frontier), last_slot: frontier }),
      getLogs: (from, to, face) => history.getLogs(from, to, face, cohort),
      timeBudgetMs: Math.max(0, deadline - now()),
      upsertCursor: async (_key, _last, block) => {
        if (block === undefined) throw new Error('arc_mainnet_seed_cursor_invalid');
        await history.write([...cohort].map(address => ({ address, block })));
        deps.signal?.throwIfAborted();
        for (const address of cohort) coverage.set(address, block);
      },
    });
  }
  const floor = Math.min(...[...seeds].map(address => coverage.get(address) ?? -1));
  const backlog = Math.max(0, head - floor);
  const unresolved = live.coverage.unresolved + (replay?.coverage.unresolved ?? 0);
  return {
    fetched: live.fetched + (replay?.fetched ?? 0), inserted: live.inserted + (replay?.inserted ?? 0),
    cursors: new Map([...live.cursors, ...[...coverage].map(([address, block]) => [SEED_CURSOR_PREFIX + address, String(block)] as const)]),
    coverage: {
      ...live.coverage, checkpoint: String(floor),
      checked: live.coverage.checked + (replay?.coverage.checked ?? 0), pending: backlog,
      unresolved,
      complete: backlog === 0 && unresolved === 0 && live.coverage.complete && (replay?.coverage.complete ?? true),
      reason: live.coverage.reason ?? replay?.coverage.reason ?? (backlog > 0 ? 'budget' : undefined),
    },
  };
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
    const seed = buildArcMainnetSeedSet(rows);
    if (deps.history && seed.size > 0) return await scanWithSeedHistory(deps, seed);
    return await arcTransfersIndexer({
      ...deps, chain: 'arc-mainnet', usdcContract: ARC_MAINNET_USDC_CONTRACT,
      seed,
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
  const readLogs = async (fromBlock: bigint, toBlock: bigint, face: TransferFace, seeds: readonly `0x${string}`[]) => {
    if (seeds.length === 0) throw new Error('arc_mainnet_seed_empty');
    const logs = await rpc(() => client.getLogs({
      address: ARC_MAINNET_TRANSFER_EMITTER, event: TRANSFER_EVENT,
      args: face === 'from' ? { from: [...seeds] } : { to: [...seeds] }, fromBlock, toBlock,
    }));
    const transfers: ArcTransfer[] = [];
    for (const log of logs) {
      const transfer = parseArcMainnetTransfer(log);
      if (transfer) transfers.push(transfer);
    }
    return transfers;
  };
  return arcMainnetTransfersIndexer({
    signal: opts.signal, windowSize: 10_000, maxWindows: opts.maxWindows ?? 50, timeBudgetMs: 120_000,
    getChainId: () => rpc(() => client.getChainId()),
    loadSeedRows: async () => {
      const rows = await loadArcMainnetSeedRows(opts.signal);
      seedList = [...buildArcMainnetSeedSet(rows)] as `0x${string}`[];
      return rows;
    },
    getHead: () => rpc(() => client.getBlockNumber()),
    getLogs: (from, to, face) => readLogs(from, to, face, seedList),
    history: {
      read: seeds => readArcMainnetSeedCoverage(seeds, opts.signal),
      write: rows => writeArcMainnetSeedCoverage(rows, opts.signal),
      getLogs: (from, to, face, seeds) => readLogs(from, to, face, [...seeds] as `0x${string}`[]),
    },
    blockTimestamp: async (blockNumber) => {
      const block = await rpc(() => client.getBlock({ blockNumber }));
      return new Date(Number(block.timestamp) * 1000).toISOString();
    },
    // Deliberately empty: every block falls through to the single-block path
    // above, which is exactly mainnet's behaviour before batching existed.
    // Testnet batches because its node was measured supporting it; no such
    // measurement exists for the mainnet endpoint, and this chain is not the
    // one that was starving on timestamp cost. Wire it once probed.
    blockTimestamps: async () => new Map<string, string>(),
    ensureWallets: makeEnsureWallets('arc-mainnet'), insertTransactions, insertSignalEvents,
    getCursor: async (key) => {
      const cursor = await getCursor(key, 'arc-mainnet');
      return cursor ?? { last_signature: String(startBlock - 1), last_slot: startBlock - 1 };
    },
    upsertCursor: async (key, last, slot) => upsertCursor(key, last, slot, 'arc-mainnet'),
  });
}
