/**
 * Celo x402 RELAYER-mode settlement indexer (Celo mainnet, EVM).
 *
 * Celo's native facilitator (api.x402.celo.org, built on x402-rs) settles by
 * submitting EIP-3009 `transferWithAuthorization` from a relayer EOA that pays
 * gas. The relayer is `tx.from`, never a Transfer party, so the payee-mode
 * indexer in `celo-x402.ts` (Transfer from/to ∈ seed set) cannot see it.
 *
 * Per block window:
 *   1. getLogs `AuthorizationUsed` on the settlement tokens → candidate tx hashes
 *      (narrow: only EIP-3009 settlements emit it, unlike Transfer, which hits
 *      Forno's 20k-result cap within ~500 blocks),
 *   2. fetch each receipt, keep those sent by a watched relayer,
 *   3. pair every `AuthorizationUsed(authorizer)` with the next same-token
 *      `Transfer(from = authorizer)` in that receipt → one settlement row.
 *
 * Rows go to `celo_x402_settlements`, a quarantine table that scoring, stats and
 * graph never read. Writing them to `transactions` would hand karma to the
 * 5-wallet payment ring that made up ~95% of this relayer's flow on 2026-10-29
 * (see `CELO_X402_RELAYERS`). Promotion waits on a cycle/self-dealing detector.
 *
 * Block time is interpolated between the window's endpoint blocks instead of
 * one getBlock per settlement: Celo L2 produces fixed 1s blocks, so the line is
 * exact there and costs 2 RPC calls per window instead of ~one per settlement.
 *
 * Cursor key `celo:x402-relayer` (separate from payee mode's `celo:x402`),
 * advanced after each window's insert so a time-budget stop never re-scans or
 * skips a committed window.
 */

import { createPublicClient, http, parseAbiItem } from 'viem';
import { celo } from 'viem/chains';
import type { Chain } from '@/db/schema';
import {
  CELO_X402_TOKENS,
  celoX402RelayerSet,
  getCeloX402Token,
  type CeloX402Token,
} from '@/config/celo-x402';
import {
  getCursor as dbGetCursor,
  upsertCursor as dbUpsertCursor,
  insertCeloX402Settlements as dbInsertSettlements,
} from '@/db/client';
import { withConcurrency } from '@/lib/concurrency';
import { INGEST_RETRY, withRateLimitRetry } from '@/lib/rpc-retry';

const CELO_CHAIN: Chain = 'celo';

/** keccak256("AuthorizationUsed(address,bytes32)") — EIP-3009. */
export const AUTHORIZATION_USED_TOPIC =
  '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5';
/** keccak256("Transfer(address,address,uint256)") — ERC-20. */
export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const AUTHORIZATION_USED = parseAbiItem(
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
);

export const CELO_RELAYER_CURSOR_KEY = 'celo:x402-relayer';
export const CELO_RELAYER_WINDOW = 5_000;
export const CELO_RELAYER_MAX_WINDOWS = 50;
/** First run with no cursor: ~6h of 1s blocks. Never scan from genesis. */
export const CELO_RELAYER_LOOKBACK_BLOCKS = 21_600;
const RECEIPT_CONCURRENCY = 8;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RelayerLog {
  address: string;
  topics: readonly string[];
  data: string;
  logIndex: number;
}

/** The receipt fields relayer matching needs (a subset of viem's receipt). */
export interface RelayerReceipt {
  transactionHash: string;
  blockNumber: bigint;
  from: string;
  status: 'success' | 'reverted';
  logs: readonly RelayerLog[];
}

export interface CeloX402Settlement {
  txHash: string;
  /** logIndex of the Transfer leg. */
  logIndex: number;
  blockNumber: bigint;
  /** ISO settlement time (interpolated, see header). Empty until stamped. */
  blockTime: string;
  relayer: string;
  /** Lowercased token contract. */
  token: string;
  symbol: CeloX402Token['symbol'];
  payer: string;
  payee: string;
  rawValue: bigint;
  /** Human units: rawValue / 10^decimals. */
  value: number;
}

// ─── Pure matching ───────────────────────────────────────────────────────────

const topicAddress = (topic: string | undefined): string | null =>
  topic && topic.length === 66 ? `0x${topic.slice(26)}`.toLowerCase() : null;

/**
 * Pure: settlements in one receipt. Empty unless the tx succeeded and was sent
 * by a watched relayer. Each `AuthorizationUsed` consumes the first later
 * Transfer on the same token whose `from` is the authorizer, so fee legs or
 * unrelated transfers in the same tx are never counted.
 */
export function matchRelayerSettlements(
  receipt: RelayerReceipt,
  relayers: ReadonlySet<string>,
): CeloX402Settlement[] {
  const relayer = receipt.from.toLowerCase();
  if (receipt.status !== 'success' || !relayers.has(relayer)) return [];

  const logs = [...receipt.logs].sort((a, b) => a.logIndex - b.logIndex);
  const used = new Set<number>();
  const out: CeloX402Settlement[] = [];

  for (const auth of logs) {
    if (auth.topics[0]?.toLowerCase() !== AUTHORIZATION_USED_TOPIC) continue;
    const token = getCeloX402Token(auth.address);
    const authorizer = topicAddress(auth.topics[1]);
    if (!token || !authorizer) continue;

    const leg = logs.find(
      (l) =>
        l.logIndex > auth.logIndex &&
        !used.has(l.logIndex) &&
        l.address.toLowerCase() === auth.address.toLowerCase() &&
        l.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
        topicAddress(l.topics[1]) === authorizer,
    );
    const payee = topicAddress(leg?.topics[2]);
    if (!leg || !payee) continue;
    used.add(leg.logIndex);

    const rawValue = BigInt(leg.data);
    out.push({
      txHash: receipt.transactionHash,
      logIndex: leg.logIndex,
      blockNumber: receipt.blockNumber,
      blockTime: '',
      relayer,
      token: token.address.toLowerCase(),
      symbol: token.symbol,
      payer: authorizer,
      payee,
      rawValue,
      value: Number(rawValue) / 10 ** token.decimals,
    });
  }
  return out;
}

interface BlockPoint { block: bigint; unix: number }

/** Pure: ISO time of `block`, linear between two known window endpoints. */
export function interpolateBlockTime(block: bigint, start: BlockPoint, end: BlockPoint): string {
  const span = Number(end.block - start.block);
  const unix = span === 0
    ? start.unix
    : start.unix + (Number(block - start.block) * (end.unix - start.unix)) / span;
  return new Date(Math.round(unix * 1000)).toISOString();
}

// ─── DI core ─────────────────────────────────────────────────────────────────

export interface CeloX402RelayerDeps {
  signal?: AbortSignal;
  /** Lowercased relayer addresses matched on `tx.from`. */
  relayers: ReadonlySet<string>;
  getHead: () => Promise<bigint>;
  /** Distinct tx hashes with an `AuthorizationUsed` on a settlement token, [from, to] inclusive. */
  getAuthorizationTxHashes: (fromBlock: bigint, toBlock: bigint) => Promise<string[]>;
  getReceipt: (txHash: string) => Promise<RelayerReceipt>;
  /** Unix seconds of a block. */
  blockUnix: (block: bigint) => Promise<number>;
  insertSettlements: (rows: CeloX402Settlement[]) => Promise<number>;
  getCursor: (key: string) => Promise<{ last_signature: string; last_slot: number | null } | null>;
  upsertCursor: (key: string, lastSignature: string, lastSlot?: number) => Promise<void>;
  startBlockFallback: bigint;
  windowSize?: number;
  maxWindows?: number;
  timeBudgetMs?: number;
  now?: () => number;
}

export interface CeloX402RelayerResult {
  fetched: number;
  inserted: number;
  cursors: Map<string, string>;
  coverage: {
    complete: boolean;
    head?: string;
    checkpoint?: string | null;
    checked: number;
    pending: number;
    unresolved: number;
    reason?: string;
  };
}

/** Index relayer-submitted settlements from the cursor toward head, window by window. */
export async function celoX402RelayerIndexer(deps: CeloX402RelayerDeps): Promise<CeloX402RelayerResult> {
  deps.signal?.throwIfAborted();
  const cursors = new Map<string, string>();
  if (deps.relayers.size === 0) {
    return { fetched: 0, inserted: 0, cursors, coverage: { complete: false, checked: 0, pending: 0, unresolved: 0, reason: 'empty_seed' } };
  }
  const windowSize = BigInt(deps.windowSize ?? CELO_RELAYER_WINDOW);
  const maxWindows = deps.maxWindows ?? CELO_RELAYER_MAX_WINDOWS;
  const now = deps.now ?? Date.now;
  const deadline = deps.timeBudgetMs == null ? Number.POSITIVE_INFINITY : now() + deps.timeBudgetMs;

  const cursor = await deps.getCursor(CELO_RELAYER_CURSOR_KEY);
  const startBlock = cursor?.last_slot != null ? BigInt(cursor.last_slot) + BigInt(1) : deps.startBlockFallback;
  const head = await deps.getHead();
  deps.signal?.throwIfAborted();

  let checkedThrough = startBlock - BigInt(1);
  let fetched = 0;
  let inserted = 0;
  let windows = 0;
  let budgetExpired = false;

  for (let from = startBlock; from <= head && windows < maxWindows; from += windowSize) {
    if (now() >= deadline) { budgetExpired = true; break; }
    const to = from + windowSize - BigInt(1) > head ? head : from + windowSize - BigInt(1);

    const hashes = await deps.getAuthorizationTxHashes(from, to);
    deps.signal?.throwIfAborted();
    const receipts = await withConcurrency(hashes, RECEIPT_CONCURRENCY, (h) => {
      deps.signal?.throwIfAborted();
      return deps.getReceipt(h);
    });
    const settlements = receipts.flatMap((r) => matchRelayerSettlements(r, deps.relayers));

    if (settlements.length > 0) {
      const [startUnix, endUnix] = await Promise.all([deps.blockUnix(from), deps.blockUnix(to)]);
      const a = { block: from, unix: startUnix };
      const b = { block: to, unix: endUnix };
      for (const s of settlements) s.blockTime = interpolateBlockTime(s.blockNumber, a, b);
      fetched += settlements.length;
      inserted += await deps.insertSettlements(settlements);
      deps.signal?.throwIfAborted();
    }

    await deps.upsertCursor(CELO_RELAYER_CURSOR_KEY, String(to), Number(to));
    cursors.set(CELO_RELAYER_CURSOR_KEY, String(to));
    checkedThrough = to;
    windows++;
  }

  const complete = checkedThrough >= head;
  return {
    fetched, inserted, cursors,
    coverage: {
      complete,
      head: String(head),
      checkpoint: windows > 0 ? String(checkedThrough) : cursor?.last_signature ?? null,
      checked: Number(checkedThrough - startBlock + BigInt(1)),
      pending: complete ? 0 : Number(head - checkedThrough),
      unresolved: 0,
      ...(complete ? {} : { reason: budgetExpired ? 'time_budget' : 'window_limit' }),
    },
  };
}

// ─── Production wiring ───────────────────────────────────────────────────────

/** Production run against Celo mainnet. `dryRun` matches and returns rows without writing or moving the cursor. */
export async function runCeloX402RelayerIndexer(
  opts: { windowSize?: number; maxWindows?: number; timeBudgetMs?: number; dryRun?: boolean; signal?: AbortSignal } = {},
): Promise<CeloX402RelayerResult & { rows?: CeloX402Settlement[] }> {
  const client = createPublicClient({
    chain: celo,
    transport: http(process.env.CELO_RPC_URL, { fetchOptions: { signal: opts.signal } }),
  });
  const retry = <T>(fn: () => Promise<T>) =>
    withRateLimitRetry(() => { opts.signal?.throwIfAborted(); return fn(); }, INGEST_RETRY);
  const tokenAddresses = CELO_X402_TOKENS.map((t) => t.address);
  const rows: CeloX402Settlement[] = [];

  const head = await retry(() => client.getBlockNumber());
  return {
    ...(await celoX402RelayerIndexer({
      signal: opts.signal,
      relayers: celoX402RelayerSet(),
      windowSize: opts.windowSize,
      maxWindows: opts.maxWindows,
      timeBudgetMs: opts.timeBudgetMs ?? 120_000,
      startBlockFallback: head - BigInt(CELO_RELAYER_LOOKBACK_BLOCKS),
      getHead: async () => head,
      getAuthorizationTxHashes: async (fromBlock, toBlock) => {
        const logs = await retry(() =>
          client.getLogs({ address: tokenAddresses, event: AUTHORIZATION_USED, fromBlock, toBlock }),
        );
        return [...new Set(logs.map((l) => l.transactionHash).filter((h): h is `0x${string}` => h !== null))];
      },
      getReceipt: async (hash) => {
        const r = await retry(() => client.getTransactionReceipt({ hash: hash as `0x${string}` }));
        return { transactionHash: r.transactionHash, blockNumber: r.blockNumber, from: r.from, status: r.status, logs: r.logs };
      },
      blockUnix: async (blockNumber) => Number((await retry(() => client.getBlock({ blockNumber }))).timestamp),
      insertSettlements: opts.dryRun
        ? async (s) => { rows.push(...s); return 0; }
        : (s) => dbInsertSettlements(s, CELO_CHAIN),
      getCursor: async (key) => {
        if (opts.dryRun) return null;
        const c = await dbGetCursor(key, CELO_CHAIN);
        return c ? { last_signature: c.last_signature, last_slot: c.last_slot } : null;
      },
      upsertCursor: opts.dryRun
        ? async () => {}
        : async (key, last, slot) => { await dbUpsertCursor(key, last, slot, CELO_CHAIN); },
    })),
    ...(opts.dryRun ? { rows } : {}),
  };
}
