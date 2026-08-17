/**
 * Arc ERC-8183 job-settlement indexer (Arc Testnet).
 *
 * Reads ERC-8183 AgenticCommerce escrow events from Arc's EVM RPC via viem
 * getLogs, pairs each `PaymentReleased` (the SETTLEMENT) with its `JobCreated`
 * (to recover the consumer/client face), and persists Tier-1 receipts:
 *   - a `transactions` row (amount in USDC 6-dec, tx_signature = settlement
 *     txHash, chain 'arc'),
 *   - a Tier-1 PROVIDER signal for the provider (got paid),
 *   - a Tier-1 CONSUMER signal for the client (paid clean, job settled).
 *
 * A settled job = a `PaymentReleased` log. Join on jobId to the `JobCreated`
 * log (same contract) to recover the client. dedup tx_ref is `<jobId>:<txHash>`.
 *
 * Cursor = block number: last_signature = String(maxBlock), last_slot =
 * maxBlock. startBlock = cursor.last_slot + 1, else ARC_JOBS_START_BLOCK (env)
 * else GENESIS_FALLBACK_BLOCK. Cursor key is namespaced by the jobs contract
 * ("arc:<jobsContract>").
 *
 * eth_getLogs on Arc is capped at a 10,000-block range per call, so the core
 * paginates in <=10k windows from the cursor up to the current head.
 *
 * DECIMALS TRAP: native gas = 18-dec; the ERC-8183 job `amount` (and the USDC
 * ERC-20 token) are 6-dec. We decode `amount` with ARC_USDC_DECIMALS (6) — the
 * 18-dec native gas accounting is never crossed in here.
 *
 * New env vars:
 *   ARC_RPC_URL          — Arc EVM RPC endpoint (required, raises if absent).
 *   ARC_JOBS_START_BLOCK — genesis block for the first scan (optional).
 */

import { createPublicClient, http, parseAbiItem, type Log } from "viem";
import type { Transaction, Chain } from "@/db/schema";
import type { IndexRunResult } from "@/chain-adapters/types";
import { arcTestnet } from "@/config/arc-chain";
import {
  insertTransactions as dbInsertTransactions,
  insertSignalEvents as dbInsertSignalEvents,
  makeEnsureWallets as dbMakeEnsureWallets,
  getCursor as dbGetCursor,
  upsertCursor as dbUpsertCursor,
  getWallet as dbGetWallet,
  type InsertSignalEventInput,
} from "@/db/client";
import { INGEST_RETRY, isRateLimitedError, withRateLimitRetry } from "@/lib/rpc-retry";
import { buildJobSettledSignal } from "@/scoring/signals";
import { readAgent } from "@/integrations/erc8004-arc";
import { isTemplatedIdentity } from "@/scoring/identity-fingerprint";

// ── ERC-8183 AgenticCommerce escrow address + decimals (Arc Testnet) ──────────

/** ERC-8183 AgenticCommerce (job escrow). Canonical Arc Testnet deployment. */
export const ARC_JOBS_CONTRACT =
  "0x0747EEf0706327138c69792bF28Cd525089e4583" as const;

/** ERC-8183 job amounts are USDC token units — 6 decimals, NOT 18-dec gas. */
export const ARC_USDC_DECIMALS = 6;

const USDC_SCALE = 10 ** ARC_USDC_DECIMALS;

// 'arc' is not yet in the schema Chain union (added by the schema CHANGES pass
// that wires Arc in after this indexer). Cast keeps this file type-safe and
// independent of that edit landing first.
const ARC_CHAIN = "arc" as Chain;

// ── Canonical EIP-8183 event ABIs (decoded via viem getLogs) ──────────────────

// Deployed contract emits a trailing `hook` address (verified against
// 0xA316fd02827242D537F84730F8a37D0BA5fd351a, the implementation behind
// ARC_JOBS_CONTRACT, via testnet.arcscan.app) that the EIP-8183 draft text
// omits. Missing it here changes the event's topic0 hash entirely, so
// getLogs's event filter matched ZERO real JobCreated logs — every
// PaymentReleased was therefore unmatched and skipped. Confirmed 2026-07-10:
// real topic0 0xb0f0239b… vs. the 5-param signature's 0xef137df1….
export const JOB_CREATED_EVENT = parseAbiItem(
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)",
);

export const PAYMENT_RELEASED_EVENT = parseAbiItem(
  "event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount)",
);

// ── Decoded event records ─────────────────────────────────────────────────────

export interface ArcJobCreated {
  jobId: bigint;
  client: `0x${string}`;
  provider: `0x${string}`;
  evaluator: `0x${string}`;
  expiredAt: bigint;
  blockNumber: bigint;
  txHash: `0x${string}`;
}

export interface ArcPaymentReleased {
  jobId: bigint;
  provider: `0x${string}`;
  /** Raw uint256 token value. Divide by 10^6 for human USDC units. */
  rawAmount: bigint;
  /** Human-units float, derived from rawAmount / 10^6 (USDC 6-dec). */
  amount: number;
  blockNumber: bigint;
  txHash: `0x${string}`;
}

/**
 * Pure: decode a raw JobCreated log. Returns null when args are incomplete
 * (a malformed/partial log never crashes the scan).
 *
 * Addresses are LOWERCASED here. viem returns EIP-55 checksummed addresses, and
 * every AK read path lowercases EVM addresses (the profile route, claims, the
 * Arc chain adapter's `normalizeAddress`, and this file's own
 * `dbGetWallet(address.toLowerCase())`). Passing the checksummed form through
 * created `wallets` rows nothing could resolve — 83,887 of 84,024 arc rows were
 * unreachable orphans by 2026-08-17, with the same agent present twice in two
 * casings. The two parsers are the choke point every address in this file flows
 * through, so normalizing once here keeps `wallets`, `transactions` and
 * `signal_events` consistent with no second place to drift.
 *
 * EVM-scoped deliberately: the shared `ensureWalletsExist` must NOT lowercase,
 * because Solana base58 addresses are case-sensitive.
 */
export function parseJobCreated(
  log: Log<bigint, number, false, typeof JOB_CREATED_EVENT>,
): ArcJobCreated | null {
  const { jobId, client, provider, evaluator, expiredAt } = log.args;
  if (jobId === undefined || !client || !provider) return null;
  return {
    jobId,
    client: client.toLowerCase() as `0x${string}`,
    provider: provider.toLowerCase() as `0x${string}`,
    evaluator: ((evaluator ??
      "0x0000000000000000000000000000000000000000").toLowerCase()) as `0x${string}`,
    expiredAt: expiredAt ?? BigInt(0),
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
  };
}

/**
 * Pure: decode a raw PaymentReleased log into a settlement record. Amount is
 * scaled by 10^6 (USDC token units). Returns null on incomplete args.
 *
 * `provider` is lowercased for the reason documented on `parseJobCreated`.
 */
export function parsePaymentReleased(
  log: Log<bigint, number, false, typeof PAYMENT_RELEASED_EVENT>,
): ArcPaymentReleased | null {
  const { jobId, provider, amount } = log.args;
  if (jobId === undefined || !provider || amount === undefined) return null;
  return {
    jobId,
    provider: provider.toLowerCase() as `0x${string}`,
    rawAmount: amount,
    amount: Number(amount) / USDC_SCALE,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
  };
}

// ─── Row mapping ──────────────────────────────────────────────────────────────

/**
 * Pure: map a settled job to an AK `transactions` row. wallet_address is the
 * CLIENT (consumer face / payer); facilitator is the ERC-8183 escrow contract;
 * counterparty is the PROVIDER (the payee — the client's actual counterparty,
 * distinct from the escrow router).
 *
 * tx_signature = `${jobId}:${txHash}` (NOT the bare txHash). transactions.
 * tx_signature is UNIQUE; a keeper MAY batch several PaymentReleased events into
 * one tx, and a bare-txHash key would collapse N batched settlements to a single
 * row (Postgres ON CONFLICT DO NOTHING) while their per-job signals all survive
 * — desyncing receipts from signals. jobId disambiguates one row per settled
 * job and mirrors buildJobSettledSignal's tx_ref. (One job settles once, so
 * jobId:txHash is itself unique.)
 */
export function toTransactionRow(
  settled: ArcPaymentReleased,
  client: string,
  observedAt: string,
): Omit<Transaction, "id"> {
  return {
    chain: ARC_CHAIN,
    wallet_address: client,
    facilitator: ARC_JOBS_CONTRACT,
    // The scored payer's (client's) true counterparty is the PROVIDER who got
    // paid — recorded distinctly from `facilitator` (the ERC-8183 escrow, the
    // matched router). Mirrors buildJobSettledSignal's `counterparty: provider`
    // on the consumer face. Powers counterparty-aware loyalty + diversity.
    // Lowercased for the same reason the parsers are: `settled` can reach here
    // from an injected getLogs that skipped parsePaymentReleased, and this row
    // carries the FK into `wallets`.
    counterparty: settled.provider.toLowerCase(),
    amount: settled.amount,
    timestamp: observedAt,
    success: true,
    tx_signature: `${settled.jobId}:${settled.txHash}`,
  };
}

// ─── DI core ──────────────────────────────────────────────────────────────────

export interface GetLogsWindow {
  created: ArcJobCreated[];
  released: ArcPaymentReleased[];
}

export interface ArcJobsIndexerDeps {
  /** ERC-8183 AgenticCommerce escrow address whose events we read. */
  jobsContract: string;
  /** Current chain head block number. Bounds the pagination loop. */
  getHead: () => Promise<bigint>;
  /**
   * Injected getLogs for a single <=10k-block window. Returns both JobCreated
   * and PaymentReleased logs in [fromBlock, toBlock] (inclusive).
   */
  getLogs: (fromBlock: bigint, toBlock: bigint) => Promise<GetLogsWindow>;
  /**
   * Optional: resolve a jobId's client when its JobCreated is not in the
   * scanned window (it landed in a prior, already-indexed window). Production
   * wiring reads the contract; the unit core leaves it undefined → such a
   * PaymentReleased is SKIPPED (see unmatched-release policy below).
   */
  resolveJobClient?: (jobId: bigint) => Promise<string | null>;
  /**
   * Optional: does `address` present a templated (bulk-mint farm) on-chain
   * identity (see identity-fingerprint.ts)? Flags the signal payload for
   * settlement-quality.ts to exclude from its distinct-counterparty gate —
   * never blocks the settlement. Left undefined → nothing is ever flagged
   * (back-compat; the unit core tests this default).
   */
  isTemplatedCounterparty?: (address: string) => Promise<boolean>;
  /** ISO timestamp source for a block (settlement time). */
  blockTimestamp: (blockNumber: bigint) => Promise<string>;
  insertTransactions: (rows: Omit<Transaction, "id">[]) => Promise<number>;
  insertSignalEvents: (inputs: InsertSignalEventInput[]) => Promise<number>;
  /** Ensure every wallet row exists before the FK-bearing inserts. Batched:
   *  the core holds the whole set, so this is ONE round trip, not one per wallet. */
  ensureWallets: (addresses: string[]) => Promise<void>;
  getCursor: (
    key: string,
  ) => Promise<{ last_signature: string; last_slot: number | null } | null>;
  upsertCursor: (
    key: string,
    lastSignature: string,
    lastSlot?: number,
  ) => Promise<void>;
  /** Max blocks per getLogs call. Arc caps eth_getLogs at 10k. */
  windowSize?: number;
  /**
   * Max windows processed per invocation (bounded backfill). When the range
   * from the cursor to head spans more than this many windows, the run stops
   * early and advances the cursor to the last processed window; the next run
   * resumes from there. Defaults to unbounded (scan the whole range to head).
   */
  maxWindows?: number;
  /**
   * Wall-clock ceiling for the window loop, in ms. On expiry the run stops and
   * banks the cursor for the windows it completed, exactly like the maxWindows
   * cap — window COUNT is a poor proxy for the work a window actually costs.
   * Omit for unbounded (the default the DI tests rely on).
   */
  timeBudgetMs?: number;
  /** Injected clock so the budget is testable without real waiting. */
  now?: () => number;
}

/**
 * Wall-clock slice a scheduled run may spend inside ONE Arc indexer.
 *
 * keep-fresh runs the jobs and transfers indexers back to back inside a
 * 6-hourly job whose steady-state total was ~2 minutes. Both are cursor-based,
 * so a slice is not a loss — it is how much catch-up each cycle buys. Sized so
 * the pair adds at most ~4 minutes to a run.
 */
export const ARC_RUN_TIME_BUDGET_MS = 120_000;

/** Arc eth_getLogs range cap. Windows must be <= this many blocks. */
export const ARC_MAX_LOG_WINDOW = 10_000;

/**
 * Default max windows per production run (bounded backfill). 50 × 10k = 500k
 * blocks/run, so a deep backfill catches up over several cron ticks without any
 * single invocation hammering the RPC. Override via opts.maxWindows.
 */
export const ARC_DEFAULT_MAX_WINDOWS = 50;

/**
 * Genesis fallback block when no cursor + no ARC_JOBS_START_BLOCK env. Arc
 * Testnet's ERC-8183 escrow was deployed recently; 0 is a safe, correct (if
 * slow) floor that a single backfill pass walks forward from. Production sets
 * ARC_JOBS_START_BLOCK to the escrow deploy block to avoid the empty-history
 * scan. See ARC_JOBS_START_BLOCK note in runArcJobsIndexer.
 */
export const GENESIS_FALLBACK_BLOCK = 0;

/** Cursor key is namespaced by the jobs contract so it never collides. */
export function arcJobsCursorKey(jobsContract: string): string {
  return `arc:${jobsContract}`;
}

/**
 * Index settled ERC-8183 jobs from the cursor up to the chain head, in <=10k
 * block windows. Pure orchestration over injected IO.
 *
 * Pairing: within each window we build a jobId → JobCreated map, then for each
 * PaymentReleased resolve its client. UNMATCHED-RELEASE POLICY: if a settlement
 * has no JobCreated in the window AND `resolveJobClient` returns null/undefined,
 * the settlement is SKIPPED (not carried forward) — without a client we cannot
 * emit the consumer face, and the dual-face settlement model forbids a
 * provider-only receipt. Skipped settlements still advance the cursor (the
 * block was scanned), so they are never re-examined.
 */
export async function arcJobsIndexer(
  deps: ArcJobsIndexerDeps,
): Promise<IndexRunResult> {
  const cursors = new Map<string, string>();
  const windowSize = deps.windowSize ?? ARC_MAX_LOG_WINDOW;
  const maxWindows = deps.maxWindows ?? Number.POSITIVE_INFINITY;
  const cursorKey = arcJobsCursorKey(deps.jobsContract);

  // Resolve start block from cursor (last_slot + 1), else genesis fallback.
  let startBlock = BigInt(GENESIS_FALLBACK_BLOCK);
  const cursor = await deps.getCursor(cursorKey);
  if (cursor?.last_slot != null)
    startBlock = BigInt(cursor.last_slot) + BigInt(1);

  const head = await deps.getHead();

  // Nothing new to scan → no-op (cursor already at/after head).
  if (startBlock > head) {
    cursors.set(cursorKey, String(head));
    return { fetched: 0, inserted: 0, cursors };
  }

  const rows: Omit<Transaction, "id">[] = [];
  const signals: InsertSignalEventInput[] = [];
  const wallets = new Set<string>();
  // Cache block timestamps so a window's many settlements at the same block
  // resolve the ISO time once.
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

  const now = deps.now ?? Date.now;
  const deadline = deps.timeBudgetMs != null ? now() + deps.timeBudgetMs : Number.POSITIVE_INFINITY;

  // Paginate in <=windowSize windows. `from`/`to` are inclusive; step is
  // windowSize blocks so [from, from+windowSize-1] never exceeds the cap.
  for (let from = startBlock; from <= head; from += BigInt(windowSize)) {
    // Checked before the window, so a window is never half-processed.
    if (now() >= deadline) break;

    let to = from + BigInt(windowSize) - BigInt(1);
    if (to > head) to = head;

    // Arc's public RPC enforces a getLogs QUOTA, not a per-second rate: it
    // serves a handful of windows and then refuses for a long stretch, so no
    // amount of pacing or backoff carries a whole run (measured 2026-08-10).
    // Treat exhaustion as "that is all for now": keep the windows already read,
    // stop, and resume from the cursor next run. Letting it throw discarded the
    // entire run's work — Arc ingest logged nothing new for 25 days.
    let window: GetLogsWindow;
    try {
      window = await deps.getLogs(from, to);
    } catch (err) {
      if (!isRateLimitedError(err)) throw err; // a real bug must still fail loudly
      break;
    }
    const { created, released } = window;

    // ONLY after a successful read — maxBlock drives the cursor, so advancing it
    // for a window we failed to read would silently skip those blocks forever.
    if (to > maxBlock) maxBlock = to;

    // jobId → client (consumer face) recovered from JobCreated in this window.
    const clientByJob = new Map<string, string>();
    for (const c of created) clientByJob.set(c.jobId.toString(), c.client);

    for (const settled of released) {
      const jobKey = settled.jobId.toString();
      let client = clientByJob.get(jobKey) ?? null;
      // JobCreated landed in an earlier window → resolve the client lazily.
      if (client === null && deps.resolveJobClient) {
        client = await deps.resolveJobClient(settled.jobId);
      }
      // Unmatched settlement → skip (cannot attribute the consumer face).
      if (client === null) continue;
      // `resolveJobClient` is injected, so its return value has not been
      // through parseJobCreated's normalization. Lowercase it here too, or an
      // unmatched-window settlement would reintroduce a checksummed wallet row.
      client = client.toLowerCase();

      const observedAt = await tsFor(settled.blockNumber);
      // Normalized here as well as in parsePaymentReleased: `getLogs` is an
      // injected dep, so a decoded record can reach this loop without passing
      // through the parser — and it is THIS loop that decides what lands in
      // wallets / transactions / signal_events. One un-normalized entry point
      // is all it takes to start minting orphan rows again (2026-08-17).
      const provider = settled.provider.toLowerCase();

      // Self-dealt job (client === provider) → skip. A wallet funding and
      // paying itself proves nothing about independent delivery, so it must
      // never read as a Tier-1 receipt (see jobId 155689, a disclosed AK test
      // settlement where one key played client+provider+evaluator).
      if (client.toLowerCase() === provider.toLowerCase()) continue;

      rows.push(toTransactionRow(settled, client, observedAt));
      wallets.add(client);
      wallets.add(provider);

      // Templated-identity check runs on each face's COUNTERPARTY (the wallet
      // being vouched for by this settlement), not on the wallet itself.
      const clientIsTemplated = deps.isTemplatedCounterparty
        ? await deps.isTemplatedCounterparty(client)
        : false;
      const providerIsTemplated = deps.isTemplatedCounterparty
        ? await deps.isTemplatedCounterparty(provider)
        : false;

      // Tier-1 receipt pair — provider got paid, client settled clean.
      // buildJobSettledSignal never sets `chain` (InsertSignalEventInput.chain
      // is optional, DB defaults to 'solana') — set it here or every Arc signal
      // silently mis-keys to the wrong chain and violates the wallets FK.
      signals.push(
        {
          ...buildJobSettledSignal({
            walletAddress: provider,
            face: "provider",
            jobId: jobKey,
            txHash: settled.txHash,
            amount: settled.amount,
            counterparty: client,
            observedAt,
            templatedCounterparty: clientIsTemplated,
          }),
          chain: ARC_CHAIN,
        },
        {
          ...buildJobSettledSignal({
            walletAddress: client,
            face: "consumer",
            jobId: jobKey,
            txHash: settled.txHash,
            amount: settled.amount,
            counterparty: provider,
            observedAt,
            templatedCounterparty: providerIsTemplated,
          }),
          chain: ARC_CHAIN,
        },
      );
    }

    // Bounded backfill: stop after maxWindows windows. maxBlock is the last
    // processed `to`, so the cursor advances exactly there and the next run
    // resumes seamlessly. Unbounded (Infinity) runs scan straight to head.
    if (++windowsProcessed >= maxWindows) break;
  }

  // Cursor advances to the last scanned block even with zero settlements, so a
  // dry window is never re-scanned.
  const advanceCursor = async (): Promise<void> => {
    await deps.upsertCursor(cursorKey, String(maxBlock), Number(maxBlock));
    cursors.set(cursorKey, String(maxBlock));
  };

  const fetched = rows.length;
  if (fetched === 0) {
    await advanceCursor();
    return { fetched: 0, inserted: 0, cursors };
  }

  // FK pre-create both faces before inserting transactions / signal_events.
  await deps.ensureWallets([...wallets]);

  const inserted = await deps.insertTransactions(rows);
  await deps.insertSignalEvents(signals);

  await advanceCursor();
  return { fetched, inserted, cursors };
}

// ─── Production wiring ──────────────────────────────────────────────────────

function getRpcUrl(): string {
  const url = process.env.ARC_RPC_URL;
  if (!url) throw new Error("ARC_RPC_URL env var is not set"); // raise, no fallback
  return url;
}

function makeClient() {
  return createPublicClient({
    chain: arcTestnet,
    transport: http(getRpcUrl()),
  });
}

/**
 * Resolve ARC_JOBS_START_BLOCK from env, else the genesis fallback. Parsed as
 * a base-10 integer; a non-numeric value raises rather than silently scanning
 * from 0.
 */
export function resolveStartBlockEnv(): number {
  const raw = process.env.ARC_JOBS_START_BLOCK;
  if (raw === undefined || raw === "") return GENESIS_FALLBACK_BLOCK;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `ARC_JOBS_START_BLOCK is not a non-negative integer: ${raw}`,
    );
  }
  return n;
}

/**
 * Cache-only templated-identity check: does `address` already have a known
 * `arc_agent_id` in `wallets` (populated by scripts/arc-backfill-agents.ts,
 * run independently and incrementally — NOT triggered from here)? If so, one
 * cheap tokenURI read confirms/denies the bulk-mint template shape. A cache
 * miss (address not yet backfilled) returns false (unresolved, not flagged) —
 * this NEVER scans the registry to resolve an unknown address; see
 * project_erc8183_hardening_plan memory for why a live reverse-lookup
 * (getLogs Transfer-log or full id-range scan) was ruled out as prohibitively
 * expensive for a per-settlement check.
 */
export async function isTemplatedCounterparty(
  address: string,
): Promise<boolean> {
  const wallet = await dbGetWallet(address.toLowerCase(), ARC_CHAIN);
  if (!wallet?.arc_agent_id) return false;
  const agent = await readAgent(wallet.arc_agent_id);
  if (!agent) return false;
  return isTemplatedIdentity(agent.tokenURI);
}

/**
 * Production indexer run. Reads the canonical Arc Testnet ERC-8183 escrow.
 * Raises on missing ARC_RPC_URL (no silent fallback).
 */
export async function runArcJobsIndexer(
  opts: {
    jobsContract?: string;
    windowSize?: number;
    maxWindows?: number;
  } = {},
): Promise<IndexRunResult> {
  const jobsContract = opts.jobsContract ?? ARC_JOBS_CONTRACT;
  const client = makeClient();
  const envStartBlock = resolveStartBlockEnv();

  return arcJobsIndexer({
    jobsContract,
    windowSize: opts.windowSize,
    maxWindows: opts.maxWindows ?? ARC_DEFAULT_MAX_WINDOWS,
    timeBudgetMs: ARC_RUN_TIME_BUDGET_MS,
    getHead: async () => withRateLimitRetry(() => client.getBlockNumber(), INGEST_RETRY),
    getLogs: async (fromBlock, toBlock) => {
      // Sequential, not Promise.all: the public Arc RPC answers -32005 to two
      // concurrent 10k-block getLogs, and keep-fresh swallowed that error in its
      // try/catch — Arc ingest silently no-oped on every green run until
      // 2026-08-10.
      const createdLogs = await withRateLimitRetry(() =>
        client.getLogs({
          address: jobsContract as `0x${string}`,
          event: JOB_CREATED_EVENT,
          fromBlock,
          toBlock,
        }),
        INGEST_RETRY,
      );
      const releasedLogs = await withRateLimitRetry(() =>
        client.getLogs({
          address: jobsContract as `0x${string}`,
          event: PAYMENT_RELEASED_EVENT,
          fromBlock,
          toBlock,
        }),
        INGEST_RETRY,
      );
      const created: ArcJobCreated[] = [];
      for (const log of createdLogs) {
        const rec = parseJobCreated(log);
        if (rec) created.push(rec);
      }
      const released: ArcPaymentReleased[] = [];
      for (const log of releasedLogs) {
        const rec = parsePaymentReleased(log);
        if (rec) released.push(rec);
      }
      return { created, released };
    },
    // A settlement whose JobCreated predates the scanned window: the client is
    // already recorded on the prior transactions row, but for a fresh run we
    // skip rather than read storage (the escrow exposes no public client
    // getter by jobId in the canonical ABI). Left undefined → core SKIPs.
    blockTimestamp: async (blockNumber) => {
      const block = await withRateLimitRetry(() => client.getBlock({ blockNumber }), INGEST_RETRY);
      return new Date(Number(block.timestamp) * 1000).toISOString();
    },
    insertTransactions: dbInsertTransactions,
    insertSignalEvents: dbInsertSignalEvents,
    // Insert-if-absent: never zeroes an existing wallet's live score.
    ensureWallets: dbMakeEnsureWallets(ARC_CHAIN),
    getCursor: async (key) => {
      const c = await dbGetCursor(key, ARC_CHAIN);
      if (c)
        return { last_signature: c.last_signature, last_slot: c.last_slot };
      // No persisted cursor → seed the start from ARC_JOBS_START_BLOCK (env)
      // via a synthetic last_slot of (start - 1), so the core's `last_slot + 1`
      // lands the first window exactly on the configured genesis block. Never
      // silently scans from block 0 when the env is set.
      return {
        last_signature: String(envStartBlock - 1),
        last_slot: envStartBlock - 1,
      };
    },
    upsertCursor: async (key, last, slot) => {
      await dbUpsertCursor(key, last, slot, ARC_CHAIN);
    },
    isTemplatedCounterparty,
  });
}
