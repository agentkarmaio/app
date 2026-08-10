/**
 * Arc plain USDC-transfer Tier-1 indexer (Arc Testnet).
 *
 * Sibling to arc-jobs.ts, but reads raw ERC-20 `Transfer` events on Arc's USDC
 * token contract directly — no ERC-8183 escrow involved. This is what lets AK
 * score AgentStack-style nanopayments (Circle Developer-Controlled Wallets
 * moving USDC wallet-to-wallet, e.g. github.com/TheVertexAgents/agent-stack-arc)
 * that never touch the job-escrow contract.
 *
 * Writes both `signal_events` and a `transactions` row (needed for Tier-2
 * scoring — activity/volume/diversity/age are computed live per profile-page
 * render from `transactions`, not from `signal_events`; see calculateScore in
 * scoring/index.ts). The `transactions` row uses `facilitator: ARC_USDC_CONTRACT`
 * (not the escrow address), so /arc's "Matched Settlements" KPI — which filters
 * on `facilitator = <escrow>` — never conflates plain transfers with ERC-8183
 * settlements (see getArcDashboardStats in db/client.ts).
 * See 2026-07-11-arc-usdc-transfer-signals-design.md.
 *
 * DEDUP vs arc-jobs: an ERC-8183 settlement's `safeTransfer`/`safeTransferFrom`
 * IS itself a Transfer event. Skip any Transfer where either side is the job
 * escrow contract — arc-jobs.ts already covers that movement at full strength.
 *
 * New env vars:
 *   ARC_RPC_URL               — Arc EVM RPC endpoint (required, raises if absent).
 *   ARC_TRANSFERS_START_BLOCK — genesis block for the first scan (optional).
 */

import { createPublicClient, http, parseAbiItem, type Log } from 'viem';
import type { Chain, Transaction } from '@/db/schema';
import type { IndexRunResult } from '@/chain-adapters/types';
import { arcTestnet } from '@/config/arc-chain';
import {
  insertTransactions as dbInsertTransactions,
  insertSignalEvents as dbInsertSignalEvents,
  makeEnsureWallet as dbMakeEnsureWallet,
  getCursor as dbGetCursor,
  upsertCursor as dbUpsertCursor,
  type InsertSignalEventInput,
} from '@/db/client';
import { INGEST_RETRY, isRateLimitedError, withRateLimitRetry } from '@/lib/rpc-retry';
import { buildUsdcTransferSignal } from '@/scoring/signals';
import { ARC_JOBS_CONTRACT, ARC_RUN_TIME_BUDGET_MS, GENESIS_FALLBACK_BLOCK } from './arc-jobs';

/**
 * Plain USDC Transfer log density on Arc Testnet is far higher than the
 * ERC-8183 job-escrow path (arc-jobs.ts) — a 10k-block window (arc-jobs's
 * ARC_MAX_LOG_WINDOW) can exceed the RPC's 20,000-result eth_getLogs cap here.
 * Confirmed 2026-07-11: a real production run failed on exactly this. Use a
 * much smaller window for this indexer specifically.
 */
export const ARC_TRANSFERS_MAX_LOG_WINDOW = 500;

/** Smaller window → more windows needed to cover the same block range as arc-jobs. */
export const ARC_TRANSFERS_DEFAULT_MAX_WINDOWS = 200;

/** Arc Testnet USDC ERC-20 token — same contract used as the ERC-8183 payment token. */
export const ARC_USDC_CONTRACT = '0x3600000000000000000000000000000000000000' as const;

/** USDC ERC-20 token units — 6 decimals. */
export const ARC_USDC_DECIMALS = 6;
const USDC_SCALE = 10 ** ARC_USDC_DECIMALS;

const ARC_CHAIN = 'arc' as Chain;

export const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

export interface ArcTransfer {
  from: `0x${string}`;
  to: `0x${string}`;
  rawAmount: bigint;
  /** Human-units float, derived from rawAmount / 10^6 (USDC 6-dec). */
  amount: number;
  blockNumber: bigint;
  txHash: `0x${string}`;
}

/** Pure: decode a raw Transfer log. Returns null on incomplete args. */
export function parseTransfer(
  log: Log<bigint, number, false, typeof TRANSFER_EVENT>,
): ArcTransfer | null {
  const { from, to, value } = log.args;
  if (!from || !to || value === undefined) return null;
  return {
    from,
    to,
    rawAmount: value,
    amount: Number(value) / USDC_SCALE,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
  };
}

/** True when either side of a transfer is the ERC-8183 escrow — already covered by arc-jobs.ts. */
function isEscrowInternal(transfer: ArcTransfer): boolean {
  const escrow = ARC_JOBS_CONTRACT.toLowerCase();
  return transfer.from.toLowerCase() === escrow || transfer.to.toLowerCase() === escrow;
}

/**
 * Pure: map a transfer to an AK `transactions` row. wallet_address is the
 * sender (consumer/payer face); counterparty is the receiver (provider/payee
 * face) — mirrors arc-jobs.ts's toTransactionRow convention. facilitator is
 * the USDC token contract itself (not an escrow), which is exactly what lets
 * getArcDashboardStats tell this apart from ERC-8183 settlements.
 */
export function toTransactionRow(
  transfer: ArcTransfer,
  usdcContract: string,
  observedAt: string,
): Omit<Transaction, 'id'> {
  return {
    chain: ARC_CHAIN,
    wallet_address: transfer.from,
    facilitator: usdcContract,
    counterparty: transfer.to,
    amount: transfer.amount,
    timestamp: observedAt,
    success: true,
    tx_signature: transfer.txHash,
  };
}

// ─── DI core ──────────────────────────────────────────────────────────────────

export interface ArcTransfersIndexerDeps {
  usdcContract: string;
  getHead: () => Promise<bigint>;
  getLogs: (fromBlock: bigint, toBlock: bigint) => Promise<ArcTransfer[]>;
  blockTimestamp: (blockNumber: bigint) => Promise<string>;
  insertTransactions: (rows: Omit<Transaction, 'id'>[]) => Promise<number>;
  insertSignalEvents: (inputs: InsertSignalEventInput[]) => Promise<number>;
  ensureWallet: (address: string) => Promise<void>;
  getCursor: (key: string) => Promise<{ last_signature: string; last_slot: number | null } | null>;
  upsertCursor: (key: string, lastSignature: string, lastSlot?: number) => Promise<void>;
  windowSize?: number;
  maxWindows?: number;
  /**
   * Wall-clock ceiling for the window loop, in ms. On expiry the run stops and
   * banks the cursor for the windows it completed, exactly like the maxWindows
   * cap. Needed because window COUNT is a poor proxy for work here: each window
   * can hold hundreds of transfers, each needing a block-timestamp round trip,
   * so 200 windows ran past 20 minutes inside a 6-hourly job on 2026-08-10.
   * Omit for unbounded (the default the DI tests rely on).
   */
  timeBudgetMs?: number;
  /** Injected clock so the budget is testable without real waiting. */
  now?: () => number;
}

/** Cursor key namespaced by the USDC contract, distinct from arc-jobs's key. */
export function arcTransfersCursorKey(usdcContract: string): string {
  return `arc-transfers:${usdcContract}`;
}

/**
 * Index plain USDC transfers from the cursor up to the chain head, in <=10k
 * block windows. Pure orchestration over injected IO — mirrors arcJobsIndexer's
 * shape (arc-jobs.ts) but with no pairing step (a Transfer is self-contained).
 */
export async function arcTransfersIndexer(deps: ArcTransfersIndexerDeps): Promise<IndexRunResult> {
  const cursors = new Map<string, string>();
  const windowSize = deps.windowSize ?? ARC_TRANSFERS_MAX_LOG_WINDOW;
  const maxWindows = deps.maxWindows ?? Number.POSITIVE_INFINITY;
  const cursorKey = arcTransfersCursorKey(deps.usdcContract);

  let startBlock = BigInt(GENESIS_FALLBACK_BLOCK);
  const cursor = await deps.getCursor(cursorKey);
  if (cursor?.last_slot != null) startBlock = BigInt(cursor.last_slot) + BigInt(1);

  const head = await deps.getHead();

  if (startBlock > head) {
    cursors.set(cursorKey, String(head));
    return { fetched: 0, inserted: 0, cursors };
  }

  const rows: Omit<Transaction, 'id'>[] = [];
  const signals: InsertSignalEventInput[] = [];
  const wallets = new Set<string>();
  const tsCache = new Map<string, string>();
  const tsFor = async (block: bigint): Promise<string> => {
    const key = block.toString();
    const cached = tsCache.get(key);
    if (cached !== undefined) return cached;
    const ts = await deps.blockTimestamp(block);
    tsCache.set(key, ts);
    return ts;
  };

  let maxBlock = startBlock - BigInt(1);
  let windowsProcessed = 0;
  let fetched = 0;

  const now = deps.now ?? Date.now;
  const deadline = deps.timeBudgetMs != null ? now() + deps.timeBudgetMs : Number.POSITIVE_INFINITY;

  for (let from = startBlock; from <= head; from += BigInt(windowSize)) {
    // Checked before the window, so a window is never half-processed: whatever
    // is already read gets banked and the next run picks up from the cursor.
    if (now() >= deadline) break;

    let to = from + BigInt(windowSize) - BigInt(1);
    if (to > head) to = head;

    // Same quota behaviour as arc-jobs.ts: keep the windows already read and
    // resume next run, rather than throwing the whole run's work away. This
    // cursor had not moved since 2026-07-11 for exactly that reason.
    let transfers: ArcTransfer[];
    try {
      transfers = await deps.getLogs(from, to);
    } catch (err) {
      if (!isRateLimitedError(err)) throw err;
      break;
    }

    // ONLY after a successful read — see arc-jobs.ts for why advancing maxBlock
    // past an unread window silently drops those blocks.
    if (to > maxBlock) maxBlock = to;

    for (const transfer of transfers) {
      if (isEscrowInternal(transfer)) continue; // covered by arc-jobs.ts already
      fetched++;

      const observedAt = await tsFor(transfer.blockNumber);
      wallets.add(transfer.from);
      wallets.add(transfer.to);

      rows.push(toTransactionRow(transfer, deps.usdcContract, observedAt));
      signals.push(
        buildUsdcTransferSignal({
          walletAddress: transfer.to, face: 'provider', chain: ARC_CHAIN,
          txHash: transfer.txHash, amount: transfer.amount, counterparty: transfer.from, observedAt,
        }),
        buildUsdcTransferSignal({
          walletAddress: transfer.from, face: 'consumer', chain: ARC_CHAIN,
          txHash: transfer.txHash, amount: transfer.amount, counterparty: transfer.to, observedAt,
        }),
      );
    }

    if (++windowsProcessed >= maxWindows) break;
  }

  const advanceCursor = async (): Promise<void> => {
    await deps.upsertCursor(cursorKey, String(maxBlock), Number(maxBlock));
    cursors.set(cursorKey, String(maxBlock));
  };

  if (fetched === 0) {
    await advanceCursor();
    return { fetched: 0, inserted: 0, cursors };
  }

  for (const w of wallets) await deps.ensureWallet(w);
  await deps.insertTransactions(rows);
  const inserted = await deps.insertSignalEvents(signals);

  await advanceCursor();
  return { fetched, inserted, cursors };
}

// ─── Production wiring ──────────────────────────────────────────────────────

function getRpcUrl(): string {
  const url = process.env.ARC_RPC_URL;
  if (!url) throw new Error('ARC_RPC_URL env var is not set'); // raise, no fallback
  return url;
}

function makeClient() {
  return createPublicClient({ chain: arcTestnet, transport: http(getRpcUrl()) });
}

export function resolveTransfersStartBlockEnv(): number {
  const raw = process.env.ARC_TRANSFERS_START_BLOCK;
  if (raw === undefined || raw === '') return GENESIS_FALLBACK_BLOCK;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`ARC_TRANSFERS_START_BLOCK is not a non-negative integer: ${raw}`);
  }
  return n;
}

/**
 * Production indexer run. OPT-IN, mirrors arc-jobs.ts: a caller that never sets
 * ARC_TRANSFERS_START_BLOCK and has no persisted cursor scans from genesis,
 * which on Arc Testnet means the ~845k-agent synthetic backlog — callers
 * SHOULD set the env var before first use (see arc-jobs.ts's own note on this).
 */
export async function runArcTransfersIndexer(
  opts: { usdcContract?: string; windowSize?: number; maxWindows?: number } = {},
): Promise<IndexRunResult> {
  const usdcContract = opts.usdcContract ?? ARC_USDC_CONTRACT;
  const client = makeClient();
  const envStartBlock = resolveTransfersStartBlockEnv();

  return arcTransfersIndexer({
    usdcContract,
    windowSize: opts.windowSize,
    maxWindows: opts.maxWindows ?? ARC_TRANSFERS_DEFAULT_MAX_WINDOWS,
    timeBudgetMs: ARC_RUN_TIME_BUDGET_MS,
    getHead: async () => withRateLimitRetry(() => client.getBlockNumber(), INGEST_RETRY),
    getLogs: async (fromBlock, toBlock) => {
      const logs = await withRateLimitRetry(() => client.getLogs({
        address: usdcContract as `0x${string}`, event: TRANSFER_EVENT, fromBlock, toBlock,
      }), INGEST_RETRY);
      const out: ArcTransfer[] = [];
      for (const log of logs) {
        const rec = parseTransfer(log);
        if (rec) out.push(rec);
      }
      return out;
    },
    blockTimestamp: async (blockNumber) => {
      const block = await withRateLimitRetry(() => client.getBlock({ blockNumber }), INGEST_RETRY);
      return new Date(Number(block.timestamp) * 1000).toISOString();
    },
    insertTransactions: dbInsertTransactions,
    insertSignalEvents: dbInsertSignalEvents,
    // Insert-if-absent: never zeroes an existing wallet's live score.
    ensureWallet: dbMakeEnsureWallet(ARC_CHAIN),
    getCursor: async (key) => {
      const c = await dbGetCursor(key, ARC_CHAIN);
      if (c) return { last_signature: c.last_signature, last_slot: c.last_slot };
      return { last_signature: String(envStartBlock - 1), last_slot: envStartBlock - 1 };
    },
    upsertCursor: async (key, last, slot) => { await dbUpsertCursor(key, last, slot, ARC_CHAIN); },
  });
}
