/**
 * Celo x402 settlement indexer (Celo mainnet, EVM).
 *
 * Scans ERC-20 `Transfer` events for the canonical x402 settlement tokens
 * (USDC, USDT, USDm) where a curated/seeded x402 facilitator-or-payee address
 * (`CELO_X402_FACILITATORS`, optionally extended by env) is the `from` or `to`,
 * and persists Tier-1 receipts:
 *   - a `transactions` row (chain 'celo', amount in human token units,
 *     tx_signature = `${txHash}:${logIndex}`, wallet_address = payer),
 *   - a Tier-1 CONSUMER signal for the payer (`from`) and a Tier-1 PROVIDER
 *     signal for the payee (`to`) — same `paysh_routed` builder the Solana /
 *     Stellar indexers use, so cross-chain scoring stays uniform.
 *
 * Mirrors the EVM event-indexer shape of `arc-jobs.ts` (cursor = block number,
 * <=Nk-block windows, bounded per run) and the from/to → consumer/provider
 * attribution of `stellar-x402.ts`.
 *
 * DORMANT until seeded: with no facilitators the run is a correct no-op (no RPC
 * round-trip), identical to the Stellar/Arc precedent. Celo has no canonical
 * public x402 facilitator (thirdweb is bring-your-own server wallet), so the
 * curated list ships empty and is seeded — via code or the CELO_X402_FACILITATORS
 * env — only with a verified resource-server/payee address.
 *
 * Cursor = block number: last_signature = String(maxBlock), last_slot = maxBlock.
 * startBlock = cursor.last_slot + 1, else CELO_X402_START_BLOCK (env), else a
 * recent-head lookback (NEVER from genesis — Celo is ~70M blocks deep). Cursor
 * key is namespaced `celo:x402`.
 *
 * Env:
 *   CELO_RPC_URL            — Celo RPC endpoint (optional; viem defaults to the
 *                             public Forno RPC, which is flaky on wide ranges).
 *   CELO_X402_FACILITATORS  — optional comma-separated extra facilitator/payee
 *                             addresses, merged with the curated config list.
 *   CELO_X402_START_BLOCK   — optional first block for the very first scan.
 */

import { createPublicClient, http, parseAbiItem, type Log } from 'viem';
import { celo } from 'viem/chains';
import type { Transaction, Chain } from '@/db/schema';
import type { IndexRunResult } from '@/chain-adapters/types';
import {
  CELO_X402_TOKENS,
  CELO_X402_FACILITATORS,
  celoX402FacilitatorSetWithDiscovered,
  getCeloX402Token,
  type CeloX402Token,
} from '@/config/celo-x402';
import {
  insertTransactions as dbInsertTransactions,
  insertSignalEvents as dbInsertSignalEvents,
  makeEnsureWallet as dbMakeEnsureWallet,
  getCursor as dbGetCursor,
  upsertCursor as dbUpsertCursor,
  type InsertSignalEventInput,
} from '@/db/client';
import { withRateLimitRetry } from '@/lib/rpc-retry';
import { buildPayshRoutedSignal } from '@/scoring/signals';

const CELO_CHAIN: Chain = 'celo';

const ERC20_TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

// ─── Decoded transfer record ────────────────────────────────────────────────

export interface CeloX402Transfer {
  txHash: `0x${string}`;
  blockNumber: bigint;
  logIndex: number;
  token: CeloX402Token;
  from: `0x${string}`;
  to: `0x${string}`;
  /** Raw uint256 token value. Divide by 10^decimals for human units. */
  rawValue: bigint;
  /** Human-units float, derived from rawValue / 10^decimals. */
  value: number;
  /** Direction relative to the facilitator we watched. */
  direction: 'incoming' | 'outgoing';
  /** Which facilitator address this matched on (lowercased). */
  facilitator: `0x${string}`;
}

/**
 * Pure: decode a raw Transfer log into a facilitator-matched record, or null
 * when the log is malformed or no watched facilitator is the `from`/`to`.
 * `facilitatorSet` must be lowercased.
 */
export function toRecord(
  log: Log<bigint, number, false, typeof ERC20_TRANSFER>,
  token: CeloX402Token,
  facilitatorSet: ReadonlySet<string>,
): CeloX402Transfer | null {
  const { from, to, value } = log.args;
  if (!from || !to || value === undefined) return null;
  if (log.blockNumber === null || log.transactionHash === null || log.logIndex === null) return null;

  const fromLc = from.toLowerCase();
  const toLc = to.toLowerCase();
  let facilitator: `0x${string}` | null = null;
  let direction: 'incoming' | 'outgoing' | null = null;
  if (facilitatorSet.has(fromLc)) {
    facilitator = from as `0x${string}`;
    direction = 'outgoing';
  } else if (facilitatorSet.has(toLc)) {
    facilitator = to as `0x${string}`;
    direction = 'incoming';
  }
  if (!facilitator || !direction) return null;

  return {
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
    token,
    from: from as `0x${string}`,
    to: to as `0x${string}`,
    rawValue: value,
    value: Number(value) / 10 ** token.decimals,
    direction,
    facilitator,
  };
}

// ─── Row + signal mapping ───────────────────────────────────────────────────

/** Stable per-event id: a tx MAY carry several matching Transfers (batch). */
export function celoTxSignature(t: Pick<CeloX402Transfer, 'txHash' | 'logIndex'>): string {
  return `${t.txHash}:${t.logIndex}`;
}

/**
 * Pure: map a transfer to an AK `transactions` row. Money flows `from` → `to`,
 * so the payer (`from`, consumer face) is the scored wallet and the matched
 * facilitator/payee is recorded as `facilitator` (mirrors Stellar's
 * from=payer / facilitator=router mapping).
 */
export function toTransactionRow(t: CeloX402Transfer, observedAt: string): Omit<Transaction, 'id'> {
  return {
    chain: CELO_CHAIN,
    wallet_address: t.from,
    facilitator: t.facilitator,
    // Payee (`to`) = the scored payer's actual counterparty, recorded distinctly
    // from `facilitator` (the matched router). Powers the counterparty-aware
    // loyalty + diversity signals once backfilled.
    counterparty: t.to,
    amount: t.value,
    timestamp: observedAt,
    success: true,
    tx_signature: celoTxSignature(t),
  };
}

/**
 * Pure: the Tier-1 consumer+provider signal pair for one transfer. `chain` is
 * set to 'celo' explicitly so the (chain, agent_wallet) FK + dedup index key to
 * the Celo wallet rows (the base builder leaves chain unset → DB default).
 */
export function toSignalPair(t: CeloX402Transfer, observedAt: string): InsertSignalEventInput[] {
  const consumer = t.from; // payer
  const provider = t.to;   // payee
  const txRef = celoTxSignature(t);
  return [
    {
      ...buildPayshRoutedSignal({
        walletAddress: consumer, face: 'consumer', txSignature: txRef,
        operatorAddress: provider, protocol: 'x402', observedAt, payerWallet: consumer,
      }),
      chain: CELO_CHAIN,
    },
    {
      ...buildPayshRoutedSignal({
        walletAddress: provider, face: 'provider', txSignature: txRef,
        operatorAddress: provider, protocol: 'x402', observedAt, payerWallet: consumer,
      }),
      chain: CELO_CHAIN,
    },
  ];
}

// ─── DI core ────────────────────────────────────────────────────────────────

export interface CeloX402IndexerDeps {
  /** Lowercased facilitator/payee addresses to match on Transfer from/to. */
  facilitators: ReadonlySet<string>;
  /** Current chain head block number. Bounds the pagination loop. */
  getHead: () => Promise<bigint>;
  /** Injected getLogs for one <=windowSize-block window — already facilitator-
   *  filtered + decoded into transfers (inclusive [fromBlock, toBlock]). */
  getLogs: (fromBlock: bigint, toBlock: bigint) => Promise<CeloX402Transfer[]>;
  /** ISO timestamp for a block (settlement time). */
  blockTimestamp: (blockNumber: bigint) => Promise<string>;
  insertTransactions: (rows: Omit<Transaction, 'id'>[]) => Promise<number>;
  insertSignalEvents: (inputs: InsertSignalEventInput[]) => Promise<number>;
  ensureWallet: (address: string) => Promise<void>;
  getCursor: (key: string) => Promise<{ last_signature: string; last_slot: number | null } | null>;
  upsertCursor: (key: string, lastSignature: string, lastSlot?: number) => Promise<void>;
  /** First block when there is no cursor and no CELO_X402_START_BLOCK. */
  startBlockFallback: bigint;
  /** Max blocks per getLogs window. */
  windowSize?: number;
  /** Max windows processed per invocation (bounded backfill). */
  maxWindows?: number;
}

export const CELO_DEFAULT_WINDOW = 5_000;
export const CELO_DEFAULT_MAX_WINDOWS = 100;
export const CELO_CURSOR_KEY = 'celo:x402';

/**
 * Index Celo x402 settlement transfers from the cursor up to the chain head, in
 * <=windowSize block windows. Pure orchestration over injected IO. No-op (no RPC)
 * when the facilitator set is empty. Cursor advances even across dry windows so
 * a scanned-but-empty range is never re-examined.
 */
export async function celoX402Indexer(deps: CeloX402IndexerDeps): Promise<IndexRunResult> {
  const cursors = new Map<string, string>();
  const windowSize = deps.windowSize ?? CELO_DEFAULT_WINDOW;
  const maxWindows = deps.maxWindows ?? CELO_DEFAULT_MAX_WINDOWS;

  // Nothing to match against → skip the RPC round-trip entirely.
  if (deps.facilitators.size === 0) {
    return { fetched: 0, inserted: 0, cursors };
  }

  // Resolve start block from cursor (last_slot + 1), else the fallback.
  let startBlock = deps.startBlockFallback;
  const cursor = await deps.getCursor(CELO_CURSOR_KEY);
  if (cursor?.last_slot != null) startBlock = BigInt(cursor.last_slot) + BigInt(1);

  const head = await deps.getHead();

  // Cursor already at/after head → no-op, but keep the cursor pinned to head.
  if (startBlock > head) {
    cursors.set(CELO_CURSOR_KEY, String(head));
    return { fetched: 0, inserted: 0, cursors };
  }

  const rows: Omit<Transaction, 'id'>[] = [];
  const signals: InsertSignalEventInput[] = [];
  const wallets = new Set<string>();
  // De-dupe across the from/to query overlap (facilitator → facilitator).
  const seen = new Set<string>();
  // Cache block timestamps so many transfers at one block resolve the ISO once.
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

  for (let from = startBlock; from <= head; from += BigInt(windowSize)) {
    let to = from + BigInt(windowSize) - BigInt(1);
    if (to > head) to = head;
    if (to > maxBlock) maxBlock = to;

    const transfers = await deps.getLogs(from, to);

    for (const t of transfers) {
      const sig = celoTxSignature(t);
      if (seen.has(sig)) continue;
      seen.add(sig);

      const observedAt = await tsFor(t.blockNumber);
      rows.push(toTransactionRow(t, observedAt));
      wallets.add(t.from);
      wallets.add(t.to);
      signals.push(...toSignalPair(t, observedAt));
    }

    if (++windowsProcessed >= maxWindows) break;
  }

  const advanceCursor = async (): Promise<void> => {
    await deps.upsertCursor(CELO_CURSOR_KEY, String(maxBlock), Number(maxBlock));
    cursors.set(CELO_CURSOR_KEY, String(maxBlock));
  };

  const fetched = rows.length;
  if (fetched === 0) {
    await advanceCursor();
    return { fetched: 0, inserted: 0, cursors };
  }

  // FK pre-create both faces before inserting transactions / signal_events.
  for (const w of wallets) await deps.ensureWallet(w);

  const inserted = await deps.insertTransactions(rows);
  await deps.insertSignalEvents(signals);

  await advanceCursor();
  return { fetched, inserted, cursors };
}

// ─── Production wiring ──────────────────────────────────────────────────────

function makeClient() {
  const rpcUrl = process.env.CELO_RPC_URL; // optional; viem defaults to public Forno
  return createPublicClient({ chain: celo, transport: http(rpcUrl) });
}

/** Recent-head lookback (~1 day at Celo's ~5s blocks) for a first seeded run
 *  with no cursor and no CELO_X402_START_BLOCK. NEVER scan from genesis. */
export const CELO_DEFAULT_LOOKBACK_BLOCKS = 17_280;

/** Parse CELO_X402_START_BLOCK (base-10), raising on a non-numeric value rather
 *  than silently scanning a wrong range. Returns null when unset. */
export function resolveStartBlockEnv(): number | null {
  const raw = process.env.CELO_X402_START_BLOCK;
  if (raw === undefined || raw === '') return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`CELO_X402_START_BLOCK is not a non-negative integer: ${raw}`);
  }
  return n;
}

/**
 * Real Celo getLogs for one window: per token, two facilitator-filtered queries
 * (from ∈ set, to ∈ set) so the public RPC returns only the few relevant logs
 * instead of every stablecoin transfer. Decoded + matched via toRecord.
 */
async function rpcGetLogs(
  client: ReturnType<typeof makeClient>,
  facilitatorList: `0x${string}`[],
  facilitatorSet: ReadonlySet<string>,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<CeloX402Transfer[]> {
  const out: CeloX402Transfer[] = [];
  for (const token of CELO_X402_TOKENS) {
    const [outLogs, inLogs] = await Promise.all([
      client.getLogs({ address: token.address, event: ERC20_TRANSFER, args: { from: facilitatorList }, fromBlock, toBlock }),
      client.getLogs({ address: token.address, event: ERC20_TRANSFER, args: { to: facilitatorList }, fromBlock, toBlock }),
    ]);
    for (const log of [...outLogs, ...inLogs]) {
      const rec = toRecord(log, token, facilitatorSet);
      if (rec) out.push(rec);
    }
  }
  return out;
}

/**
 * Production indexer run. Reads the curated + env-seeded facilitator set and
 * scans Celo mainnet. No-op (no RPC) until at least one facilitator is seeded.
 *
 * `opts.dryRun` returns the would-be `transactions` rows WITHOUT writing to the
 * DB or advancing the cursor — the local verification path before a real write.
 */
export async function runCeloX402Indexer(
  opts: { windowSize?: number; maxWindows?: number; dryRun?: boolean } = {},
): Promise<IndexRunResult & { rows?: Omit<Transaction, 'id'>[] }> {
  // Curated/env set UNIONED with self-seeded discovered payees (verified rows in
  // celo_x402_payees). Empty-set no-op preserved when all sources are empty.
  const facilitatorSet = await celoX402FacilitatorSetWithDiscovered();
  if (facilitatorSet.size === 0) {
    return { fetched: 0, inserted: 0, cursors: new Map() };
  }

  const client = makeClient();
  const facilitatorList = [...facilitatorSet] as `0x${string}`[];
  const envStart = resolveStartBlockEnv();

  // Dry-run: collect rows via the same window logic, no DB writes, no cursor.
  if (opts.dryRun) {
    const head = await client.getBlockNumber();
    let start = envStart != null ? BigInt(envStart) : head - BigInt(CELO_DEFAULT_LOOKBACK_BLOCKS);
    if (start < BigInt(0)) start = BigInt(0);
    const windowSize = BigInt(opts.windowSize ?? CELO_DEFAULT_WINDOW);
    const maxWindows = opts.maxWindows ?? CELO_DEFAULT_MAX_WINDOWS;
    const rows: Omit<Transaction, 'id'>[] = [];
    const seen = new Set<string>();
    let processed = 0;
    for (let from = start; from <= head; from += windowSize) {
      let to = from + windowSize - BigInt(1);
      if (to > head) to = head;
      const transfers = await rpcGetLogs(client, facilitatorList, facilitatorSet, from, to);
      for (const t of transfers) {
        const sig = celoTxSignature(t);
        if (seen.has(sig)) continue;
        seen.add(sig);
        const block = await client.getBlock({ blockNumber: t.blockNumber });
        rows.push(toTransactionRow(t, new Date(Number(block.timestamp) * 1000).toISOString()));
      }
      if (++processed >= maxWindows) break;
    }
    return { fetched: rows.length, inserted: 0, cursors: new Map(), rows };
  }

  return celoX402Indexer({
    facilitators: facilitatorSet,
    windowSize: opts.windowSize,
    maxWindows: opts.maxWindows,
    startBlockFallback:
      envStart != null
        ? BigInt(envStart)
        : (await client.getBlockNumber()) - BigInt(CELO_DEFAULT_LOOKBACK_BLOCKS),
    getHead: async () => withRateLimitRetry(() => client.getBlockNumber()),
    getLogs: (fromBlock, toBlock) =>
      withRateLimitRetry(() => rpcGetLogs(client, facilitatorList, facilitatorSet, fromBlock, toBlock)),
    blockTimestamp: async (blockNumber) => {
      const block = await withRateLimitRetry(() => client.getBlock({ blockNumber }));
      return new Date(Number(block.timestamp) * 1000).toISOString();
    },
    insertTransactions: dbInsertTransactions,
    insertSignalEvents: dbInsertSignalEvents,
    // Insert-if-absent: never zeroes an existing wallet's live score.
    ensureWallet: dbMakeEnsureWallet(CELO_CHAIN),
    getCursor: async (key) => {
      const c = await dbGetCursor(key, CELO_CHAIN);
      return c ? { last_signature: c.last_signature, last_slot: c.last_slot } : null;
    },
    upsertCursor: async (key, last, slot) => { await dbUpsertCursor(key, last, slot, CELO_CHAIN); },
  });
}

// ─── Probe surface (back-compat for scripts/celo-x402-probe.ts) ──────────────

interface DiscoverOpts {
  fromBlock: bigint;
  toBlock: bigint | 'latest';
  /** Optional subset of facilitator addresses; defaults to the full curated list. */
  facilitators?: `0x${string}`[];
}

/**
 * Read Transfer events for x402 settlement tokens that involve a known Celo
 * facilitator over a block range. No DB writes — the caller decides what to do.
 * Retained for the one-shot probe script.
 */
export async function discoverFacilitatorTransfers(
  opts: DiscoverOpts,
): Promise<CeloX402Transfer[]> {
  const facilitatorPool =
    opts.facilitators ?? CELO_X402_FACILITATORS.map((f) => f.address);
  if (facilitatorPool.length === 0) return [];
  const facilitatorSet = new Set(facilitatorPool.map((a) => a.toLowerCase()));

  const client = makeClient();
  const out: CeloX402Transfer[] = [];
  for (const token of CELO_X402_TOKENS) {
    const logs = await client.getLogs({
      address: token.address,
      event: ERC20_TRANSFER,
      fromBlock: opts.fromBlock,
      toBlock: opts.toBlock,
    });
    for (const log of logs) {
      const record = toRecord(log, token, facilitatorSet);
      if (record) out.push(record);
    }
  }
  return out;
}

export { getCeloX402Token, CELO_X402_TOKENS, CELO_X402_FACILITATORS };
