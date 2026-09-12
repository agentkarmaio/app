/**
 * Arc plain USDC-transfer Tier-1 indexer (Arc Testnet), scoped by a seed set.
 *
 * Sibling to arc-jobs.ts, but reads raw ERC-20 `Transfer` events on Arc's USDC
 * token contract directly — no ERC-8183 escrow involved. This is what lets AK
 * score AgentStack-style nanopayments (Circle Developer-Controlled Wallets
 * moving USDC wallet-to-wallet, e.g. github.com/TheVertexAgents/agent-stack-arc)
 * that never touch the job-escrow contract.
 *
 * SCOPE IS A SEED SET, NOT A HEURISTIC. This indexer was PAUSED on 2026-08-10
 * because it scanned the whole token contract: `O(chain)`, ~1.13M rows/day
 * against a `transactions` table of ~1M, and structurally unable to keep pace
 * with Arc's 165,679 blocks/day. It is scoped now the same way
 * stellar-transfers.ts is — by the set of addresses AgentKarma already cares
 * about — and the filter runs SERVER-SIDE: `Transfer` has both faces indexed,
 * so `eth_getLogs` takes an OR-array per topic position and the node applies
 * it. Indexed topics are Arc's Horizon. Measured 2026-09-10: 6 matches per
 * 10k-block window at head against ~54,000 unfiltered, at 20,000 addresses per
 * call with no chunking.
 *
 * Rows feed src/scoring/reciprocity.ts, which reads BOTH directions: outbound
 * `WHERE wallet_address = W` and inbound `WHERE counterparty = W`. Every row
 * here therefore carries a real payee — a null-counterparty row is invisible to
 * the inbound lookup and makes a wallet look MORE independent than it is.
 *
 * Writes both `signal_events` and a `transactions` row (needed for Tier-2
 * scoring — activity/volume/diversity/age are computed live per profile-page
 * render from `transactions`, not from `signal_events`; see calculateScore in
 * scoring/index.ts). The `transactions` row uses `facilitator: ARC_USDC_CONTRACT`
 * (not the escrow address), so /arc's "Matched Settlements" KPI — which filters
 * on `facilitator = <escrow>` — never conflates plain transfers with ERC-8183
 * settlements (see getArcDashboardStats in db/client.ts).
 *
 * (the original design notes are kept out of this repo)
 *
 * Env vars:
 *   ARC_RPC_URL               — Arc EVM RPC endpoint (required, raises if absent).
 *   ARC_TRANSFERS_START_BLOCK — genesis block for the first scan (optional).
 */

import { createPublicClient, http, parseAbiItem, type Log } from 'viem';
import type { Chain } from '@/db/schema';
import { readArcLogRange, withArcLogRetry, isArcLogRangeError, arcIndexCoverage, ARC_LOG_BUDGET_EXHAUSTED, type ArcIndexRunResult, type ArcIndexCoverage } from './arc-log-range';
import { arcTestnet } from '@/config/arc-chain';
import { ARC_MAINNET_TRANSFER_EMITTER, ARC_MAINNET_TRANSFER_EXCLUSIONS, ARC_MAINNET_TRANSFER_DECIMALS, ARC_MAINNET_USDC_CONTRACT } from '@/config/arc-mainnet';
import {
  insertTransactions as dbInsertTransactions,
  insertSignalEvents as dbInsertSignalEvents,
  makeEnsureWallets as dbMakeEnsureWallets,
  getCursor as dbGetCursor,
  upsertCursor as dbUpsertCursor,
  supabase,
  type InsertSignalEventInput,
  type TransactionInsert,
} from '@/db/client';
import { INGEST_RETRY, isRateLimitedError, withRateLimitRetry } from '@/lib/rpc-retry';
import { withConcurrency } from '@/lib/concurrency';
import { buildUsdcTransferSignal } from '@/scoring/signals';
import { ARC_JOBS_CONTRACT, ARC_RUN_TIME_BUDGET_MS, GENESIS_FALLBACK_BLOCK } from './arc-jobs';

/**
 * Block range per `getLogs` call — the RPC's documented cap.
 *
 * This was 500 while the indexer scanned the whole token contract, because a
 * 10k-block window there exceeded the RPC's 20,000-RESULT cap (confirmed by a
 * production failure on 2026-07-11). That cap is a function of matches, not of
 * blocks, and a seed-filtered window returns single digits — so the range cap
 * is what binds now. Restoring 10k is what makes catch-up possible at all: at
 * 500 the indexer covered ~11.5k blocks/run against a chain producing 165,679
 * blocks/day, losing ground every single day it ran.
 */
export const ARC_TRANSFERS_MAX_LOG_WINDOW = 10_000;

/** Windows per run, before the wall-clock budget. Two getLogs calls each. */
export const ARC_TRANSFERS_DEFAULT_MAX_WINDOWS = 200;

/**
 * Parallel block-timestamp lookups per window. One `getBlock` per distinct
 * block carrying a KEPT transfer. This was the run's dominant cost while the
 * scan was unfiltered (~500 blocks per window); a seed-filtered window needs a
 * handful. The prefetch stays because a dense backfill window still benefits
 * and the bound costs nothing when there is nothing to fetch.
 */
export const BLOCK_TS_CONCURRENCY = 20;

/** Arc Testnet USDC ERC-20 token — same contract used as the ERC-8183 payment token. */
export const ARC_USDC_CONTRACT = '0x3600000000000000000000000000000000000000' as const;

/** USDC ERC-20 token units — 6 decimals. */
export const ARC_USDC_DECIMALS = 6;
const USDC_SCALE = 10 ** ARC_USDC_DECIMALS;

/**
 * The EVM null address. Two distinct roles here, both requiring exclusion:
 *   - `Transfer` from/to it is a USDC MINT or BURN — Circle's issuance, not an
 *     agent payment.
 *   - `IdentityRegistry.getAgentWallet()` returns it when an agent never set a
 *     custom wallet, and the registry mirror stores that faithfully. 25 arc
 *     `erc8004_agents` rows carry it in `agent_wallet` today.
 */
export const ARC_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

const ARC_CHAIN = 'arc' as Chain;
export type ArcTransferChain = 'arc' | 'arc-mainnet';

/**
 * Addresses that are asset or protocol INFRASTRUCTURE, never a payment
 * counterparty. Checked against BOTH faces of every transfer, and subtracted
 * from the seed set.
 *
 * Both checks are load-bearing and neither subsumes the other:
 *   - Subtracting from the seed stops the firehose. Measured at head, one
 *     10k-block window: the zero address alone matched 495 outbound + 952
 *     inbound transfers, against 6 for the entire 1,730-address clean seed —
 *     99.6% of the output would have been Circle's USDC issuance recorded as
 *     agent-to-agent reputation. This is Arc's version of the Circle USDC
 *     issuer that sat in Stellar's `wallets` (see STELLAR_SEED_EXCLUSIONS).
 *   - Checking per-transfer stops the rest. A SEEDED agent minting or burning
 *     matches the filter legitimately, and would be persisted with the zero
 *     address as its `counterparty` — reciprocity.ts would read a burn as
 *     revenue leaving to a "customer". Across 7 sampled 10k-block windows,
 *     65 of 202 post-seed matches (32%) were mint/burn/self by a seeded agent.
 *
 * The escrow entry preserves the original dedup rule: an ERC-8183 settlement's
 * `safeTransfer`/`safeTransferFrom` IS a Transfer event, and arc-jobs.ts
 * already covers that movement at full strength.
 *
 * Lowercase, because every EVM address in this file is (2026-08-17).
 */
export const ARC_TRANSFER_EXCLUSIONS: ReadonlySet<string> = new Set<string>([
  ARC_ZERO_ADDRESS,
  ARC_USDC_CONTRACT.toLowerCase(),
  ARC_JOBS_CONTRACT.toLowerCase(),
]);

/**
 * Extension point: partner agents to index that are not (yet) discoverable from
 * `erc8004_agents` or `wallets`.
 *
 * Add a `0x…` address here to bring it into scope without touching indexer
 * code. Entries are shape-gated and exclusion-filtered like every other seed
 * source, so a typo drops out rather than widening the scan.
 */
export const ARC_SEED_EXTRA: readonly string[] = [];

export const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

/** Which indexed topic position a `getLogs` call filters on. */
export type TransferFace = 'from' | 'to';

export interface ArcTransfer {
  from: `0x${string}`;
  to: `0x${string}`;
  rawAmount: bigint;
  /** Human-units float, derived from rawAmount / 10^6 (USDC 6-dec). */
  amount: number;
  blockNumber: bigint;
  txHash: `0x${string}`;
  /** Mainnet uses one receipt per system event; testnet keeps legacy tx identity. */
  logIndex?: number;
  emitter?: `0x${string}`;
  decimals?: number;
  /** Exact mainnet native USDC amount, never rounded through a JS number. */
  amountDecimal?: string;
}

/**
 * Pure: decode a raw Transfer log. Returns null on incomplete args.
 *
 * Addresses are LOWERCASED here. viem returns EIP-55 checksummed addresses,
 * and every AK read path lowercases EVM addresses (the profile route, claims,
 * the Arc chain adapter's `normalizeAddress`, this indexer's own wallet
 * lookups). Passing the checksummed form through created `wallets` rows nothing
 * could resolve — 83,887 of 84,024 arc rows were unreachable orphans by
 * 2026-08-17. This parser is the choke point every address in this file flows
 * through, so normalizing once here keeps `wallets`, `transactions` and
 * `signal_events` consistent with no second place to drift.
 *
 * EVM-scoped deliberately: the shared `ensureWalletsExist` must NOT lowercase,
 * because Solana base58 addresses are case-sensitive.
 */
export function parseTransfer(
  log: Log<bigint, number, false, typeof TRANSFER_EVENT>,
): ArcTransfer | null {
  const { from, to, value } = log.args;
  if (!from || !to || value === undefined) return null;
  return {
    from: from.toLowerCase() as `0x${string}`,
    to: to.toLowerCase() as `0x${string}`,
    rawAmount: value,
    amount: Number(value) / USDC_SCALE,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
  };
}

/**
 * True when either side of a transfer is asset or protocol infrastructure.
 * See {@link ARC_TRANSFER_EXCLUSIONS} for why each entry is there.
 */
export function touchesExcluded(
  transfer: ArcTransfer,
  exclusions: ReadonlySet<string> = ARC_TRANSFER_EXCLUSIONS,
): boolean {
  return exclusions.has(transfer.from.toLowerCase())
    || exclusions.has(transfer.to.toLowerCase());
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
  chain: ArcTransferChain = 'arc',
): TransactionInsert {
  return {
    chain,
    wallet_address: transfer.from,
    facilitator: usdcContract,
    counterparty: transfer.to,
    amount: chain === 'arc-mainnet' ? exactMainnetAmount(transfer) : transfer.amount,
    timestamp: observedAt,
    success: true,
    tx_signature: arcTransferReceiptKey(transfer, chain),
  };
}

/** Mainnet event identity preserves multiple payments inside one EVM transaction. */
export function arcTransferReceiptKey(transfer: ArcTransfer, chain: ArcTransferChain): string {
  if (chain === 'arc') return transfer.txHash;
  if (!Number.isSafeInteger(transfer.logIndex) || transfer.logIndex! < 0 || !/^0x[0-9a-fA-F]{64}$/.test(transfer.txHash)
    || transfer.emitter?.toLowerCase() !== ARC_MAINNET_TRANSFER_EMITTER || transfer.decimals !== ARC_MAINNET_TRANSFER_DECIMALS) {
    throw new Error('arc_mainnet_transfer_invalid');
  }
  return `${transfer.txHash.toLowerCase()}:${transfer.logIndex}`;
}
function exactMainnetAmount(transfer: ArcTransfer): string {
  const raw = transfer.rawAmount;
  if (raw <= 0n || raw >= 10n ** 38n) throw new Error('arc_mainnet_transfer_invalid');
  const integer = raw / 10n ** 18n;
  const fraction = (raw % (10n ** 18n)).toString().padStart(18, '0').replace(/0+$/, '');
  const amount = fraction ? `${integer}.${fraction}` : String(integer);
  if (transfer.amountDecimal !== amount || transfer.amount !== Number(amount)) throw new Error('arc_mainnet_transfer_invalid');
  return amount;
}

// ─── Seed set ─────────────────────────────────────────────────────────────────

/** A 20-byte hex address, already lowercased. */
const ADDRESS_SHAPE = /^0x[0-9a-f]{40}$/;

/**
 * A `wallets` row, with the two markers that distinguish an intentional AK
 * relationship from a row this very indexer minted. See {@link isIntentional}.
 */
export interface SeedWalletRow {
  address?: string | null;
  /** The operator claimed this wallet through AK's claim flow. */
  claimed?: boolean | null;
  /** The wallet is bound to an ERC-8004 agent on Arc's IdentityRegistry. */
  arc_agent_id?: number | null;
  /** Present so the type documents what is deliberately NOT a marker. */
  score?: number | null;
}

/**
 * Does this `wallets` row represent a relationship someone deliberately
 * established with AgentKarma?
 *
 * THIS GATE EXISTS TO BREAK A FEEDBACK LOOP, not to be tidy. The indexer calls
 * `ensureWallets` for BOTH faces of every transfer it keeps, minting a
 * `wallets` row for each counterparty — seeded or not. If the seed set then
 * read every `wallets` row, run N's counterparties would become run N+1's
 * filter targets: a transitive closure over the USDC payment graph, one hop per
 * run, reaching exchange hot wallets within a few 6-hourly ticks. That is the
 * firehose this whole design exists to avoid, arriving through the back door.
 *
 * Arc is more exposed than Stellar, measurably: across 7 sampled 10k-block
 * windows, ZERO of 137 kept transfers had both sides seeded. Every kept row
 * mints a fresh `wallets` row, so the closure would expand at close to its
 * maximum rate — and `wallets` already holds 85,874 arc rows against a
 * 1,730-address seed.
 *
 * A minted row has `claimed = false` (the column default) and a NULL
 * `arc_agent_id`, so it never qualifies and the loop cannot start.
 * `ensureWalletsExist` writes only `{ chain, address }`; the only writers of
 * `arc_agent_id` are scripts/arc-backfill-agents.ts and the `explore_agents`
 * read-path projection, neither on the ingest hot path.
 *
 * `score > 0` is deliberately NOT a marker: this indexer's own rows put a
 * minted wallet on the rescore queue, so scoring would readmit it next run.
 */
export function isIntentional(row: SeedWalletRow): boolean {
  return row.claimed === true || row.arc_agent_id != null;
}

export interface SeedSetInput {
  /** `erc8004_agents` rows for chain 'arc'. BOTH columns are taken. */
  registryRows?: ReadonlyArray<{ owner?: string | null; agent_wallet?: string | null }>;
  /**
   * `wallets` rows for chain 'arc'. Only rows passing {@link isIntentional} are
   * seeded — `wallets` is open-membership and this indexer writes into it.
   */
  walletRows?: ReadonlyArray<SeedWalletRow>;
  /** Explicitly-added partner agents. Defaults to ARC_SEED_EXTRA. */
  extra?: readonly string[];
  /** Overridable for tests. Defaults to ARC_TRANSFER_EXCLUSIONS. */
  exclusions?: ReadonlySet<string>;
}

/**
 * Pure: build the set of addresses AgentKarma already cares about.
 *
 * THE single place scope is decided — extend it here, never by loosening a
 * filter in the indexer core.
 *
 * Sources are unioned, then three gates apply:
 *   - case: lowercased. EVM rows are lowercase everywhere (2026-08-17), and
 *     this set is both compared against transfer faces and passed to getLogs,
 *     so a checksummed registry row would become unmatchable.
 *   - shape: 20-byte hex only, which drops malformed rows at no extra cost.
 *   - exclusions: asset and protocol infrastructure. See
 *     ARC_TRANSFER_EXCLUSIONS for why that is load-bearing rather than tidy.
 *
 * SIZE IS BOUNDED BY THE REGISTRY MIRROR, WHICH IS DELIBERATELY CAPPED. Arc
 * testnet's IdentityRegistry holds a contiguous ~845,036-id bulk-minted space;
 * the 2026-07-08 decision was not to full-mirror it, so `erc8004_agents` holds
 * 2,752 arc rows → 1,728 distinct addresses. If that mirror is ever widened,
 * this seed widens with it — an OR-array of 20,000 addresses is fine (measured),
 * 845k is not.
 */
export function buildArcSeedSet(input: SeedSetInput = {}): Set<string> {
  const exclusions = input.exclusions ?? ARC_TRANSFER_EXCLUSIONS;
  const seed = new Set<string>();

  const add = (address: string | null | undefined): void => {
    if (!address) return;
    const normalized = address.toLowerCase();
    if (!ADDRESS_SHAPE.test(normalized)) return;
    if (exclusions.has(normalized)) return;
    seed.add(normalized);
  };

  for (const row of input.registryRows ?? []) {
    // BOTH faces: either can be the payment side. A row whose `agent_wallet` is
    // the zero-address sentinel still lands via `owner`, which is exactly what
    // registryRowAddress() (db/client.ts) does on the read path.
    add(row.owner);
    add(row.agent_wallet);
  }
  // Marker gate — breaks the mint→seed→filter feedback loop. See isIntentional().
  for (const row of input.walletRows ?? []) {
    if (!isIntentional(row)) continue;
    add(row.address);
  }
  for (const address of input.extra ?? ARC_SEED_EXTRA) add(address);

  return seed;
}

// ─── DI core ──────────────────────────────────────────────────────────────────

export interface ArcTransfersIndexerDeps {
  chain?: ArcTransferChain;
  signal?: AbortSignal;
  usdcContract: string;
  /**
   * Everything AK cares about — REQUIRED, never optional. An optional seed
   * defaulting to "unfiltered" would make the firehose the default. An EMPTY
   * seed is a no-op run, not an unfiltered one (see the guard in the core).
   */
  seed: ReadonlySet<string>;
  getHead: () => Promise<bigint>;
  /**
   * One filtered read. `face` selects which indexed topic position carries the
   * seed OR-array: `args: { from: [...] }` and `args: { to: [...] }` are AND-ed
   * across positions by the node, so the union needs two calls.
   */
  getLogs: (fromBlock: bigint, toBlock: bigint, face: TransferFace) => Promise<ArcTransfer[]>;
  blockTimestamp: (blockNumber: bigint) => Promise<string>;
  insertTransactions: (rows: TransactionInsert[]) => Promise<number>;
  insertSignalEvents: (inputs: InsertSignalEventInput[]) => Promise<number>;
  /** Batched — see arc-jobs.ts. One round trip for the whole run's wallet set. */
  ensureWallets: (addresses: string[]) => Promise<void>;
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
export function arcTransfersCursorKey(usdcContract: string, chain: ArcTransferChain = 'arc'): string {
  return `${chain}-transfers:${usdcContract}`;
}

/**
 * Index seed-scoped USDC transfers from the cursor up to the chain head, in
 * <=10k block windows. Pure orchestration over injected IO — mirrors
 * arcJobsIndexer's shape (arc-jobs.ts) but with no pairing step (a Transfer is
 * self-contained).
 */
export async function arcTransfersIndexer(deps: ArcTransfersIndexerDeps): Promise<ArcIndexRunResult> {
  const assertActive = () => deps.signal?.throwIfAborted();
  assertActive();
  const cursors = new Map<string, string>();
  const windowSize = deps.windowSize ?? ARC_TRANSFERS_MAX_LOG_WINDOW;
  const maxWindows = deps.maxWindows ?? Number.POSITIVE_INFINITY;
  const chain = deps.chain ?? 'arc';
  if (chain === 'arc-mainnet' && deps.usdcContract.toLowerCase() !== ARC_MAINNET_USDC_CONTRACT) throw new Error('arc_mainnet_transfer_invalid');
  const cursorKey = arcTransfersCursorKey(deps.usdcContract, chain);
  const exclusions = chain === 'arc-mainnet' ? ARC_MAINNET_TRANSFER_EXCLUSIONS : ARC_TRANSFER_EXCLUSIONS;

  // EMPTY SEED = NO-OP, BEFORE ANY IO. It is unverified what a node does with
  // an empty topic OR-array and "match everything" is a plausible answer — the
  // firehose, arriving because a DB read came back empty. The cursor is NOT
  // advanced either: an empty seed means we know nothing about these blocks,
  // not that they are clean.
  if (deps.seed.size === 0) {
    console.warn('[arc-transfers] seed set is empty — skipping run (no RPC calls, no cursor move)');
    return { fetched: 0, inserted: 0, cursors, coverage: { complete: false, head: '', checkpoint: null, checked: 0, pending: 0, unresolved: 0, reason: 'empty_seed' } };
  }

  let startBlock = BigInt(GENESIS_FALLBACK_BLOCK);
  const cursor = await deps.getCursor(cursorKey);
  assertActive();
  if (cursor?.last_slot != null) startBlock = BigInt(cursor.last_slot) + BigInt(1);

  const head = await deps.getHead();
  assertActive();

  if (startBlock > head) {
    if (cursor?.last_slot != null) cursors.set(cursorKey, String(cursor.last_slot));
    return { fetched: 0, inserted: 0, cursors, coverage: arcIndexCoverage(head, startBlock, startBlock - 1n, cursor?.last_slot ?? null) };
  }

  const rows: TransactionInsert[] = [];
  const signals: InsertSignalEventInput[] = [];
  const wallets = new Set<string>();
  const tsCache = new Map<string, string>();

  /**
   * Run-level, deliberately not per-window. `tx_signature` is UNIQUE, so at
   * most one row per transaction can ever land — and a transfer between two
   * seeded addresses is returned by BOTH the from-side and the to-side call.
   * Counting it twice would make `fetched` overstate what was persisted.
   */
  const seenTxHashes = new Set<string>();

  let maxBlock = startBlock - BigInt(1);
  let windowsProcessed = 0;
  let stopped: ArcIndexCoverage['reason'];
  let fetched = 0;

  const now = deps.now ?? Date.now;
  const deadline = deps.timeBudgetMs != null ? now() + deps.timeBudgetMs : Number.POSITIVE_INFINITY;

  for (let from = startBlock; from <= head; from += BigInt(windowSize)) {
    assertActive();
    // Checked before the window, so a window is never half-processed: whatever
    // is already read gets banked and the next run picks up from the cursor.
    if (now() >= deadline || windowsProcessed >= maxWindows) { stopped = 'budget'; break; }

    let to = from + BigInt(windowSize) - BigInt(1);
    if (to > head) to = head;

    // Both faces, or neither. Same quota behaviour as arc-jobs.ts: keep the
    // windows already read and resume next run, rather than throwing the whole
    // run's work away. This cursor had not moved since 2026-08-10 for exactly
    // that reason.
    let raw: ArcTransfer[];
    try {
      // Sequential reads avoid concurrent quota pressure and dangling work
      // after one face rejects. Each face must cover the entire logical window.
      const readFace = (face: TransferFace) => readArcLogRange(from, to,
        (lower, upper) => deps.getLogs(lower, upper, face),
        (left, right) => [...left, ...right],
        () => deadline !== Number.POSITIVE_INFINITY && now() >= deadline,
        deps.signal,
      );
      const outbound = await readFace('from');
      const inbound = await readFace('to');
      raw = [...outbound, ...inbound];
    } catch (err) {
      assertActive();
      if (err === ARC_LOG_BUDGET_EXHAUSTED) stopped = 'budget';
      else if (!isArcLogRangeError(err) && isRateLimitedError(err)) stopped = 'rate_limited';
      else throw err;
      break;
    }

    // ONLY after BOTH reads succeeded — see arc-jobs.ts for why advancing
    // maxBlock past an unread window silently drops those blocks. A window
    // whose second call failed has been read on one face only, which is worse
    // than not read at all.
    if (to > maxBlock) maxBlock = to;

    // Decide what to keep BEFORE spending a round trip on block timestamps.
    const kept: ArcTransfer[] = [];
    for (const record of raw) {
      // Normalize at the DB boundary as well as in parseTransfer. `getLogs` is
      // an injected dep, so decoded records can reach this loop without passing
      // through the parser — and it is THIS loop that decides what lands in
      // wallets / transactions / signal_events. One un-normalized entry point
      // is all it takes to start minting orphan rows again (2026-08-17).
      const transfer: ArcTransfer = {
        ...record,
        from: record.from.toLowerCase() as `0x${string}`,
        to: record.to.toLowerCase() as `0x${string}`,
      };

      // Infrastructure on either side: mint/burn, the token predeploy, or the
      // ERC-8183 escrow (already covered by arc-jobs.ts at full strength).
      const receiptKey = arcTransferReceiptKey(transfer, chain);
      if (chain === 'arc-mainnet') exactMainnetAmount(transfer);
      if (touchesExcluded(transfer, exclusions)) continue;
      // Self-transfer: normalizeCounterparty() would null the counterparty,
      // producing exactly the row that degrades the independence read.
      if (transfer.from === transfer.to) continue;
      // Seed scope. NOT redundant with the topic filter: `getLogs` is a DI seam
      // and the core must not trust that a record reaching it was filtered.
      if (!deps.seed.has(transfer.from) && !deps.seed.has(transfer.to)) continue;
      if (seenTxHashes.has(receiptKey)) continue;
      seenTxHashes.add(receiptKey);

      kept.push(transfer);
    }

    // Warm every block timestamp the kept set needs, in parallel, BEFORE the
    // per-transfer loop reads them one at a time. Fetching them lazily made one
    // sequential round trip per distinct block (~13s/window when the scan was
    // unfiltered, measured 2026-08-10).
    const needed = [
      ...new Set(kept.map((t) => t.blockNumber.toString()).filter((b) => !tsCache.has(b))),
    ];
    await withConcurrency(needed, BLOCK_TS_CONCURRENCY, async (b) => {
      assertActive();
      const timestamp = await deps.blockTimestamp(BigInt(b));
      assertActive();
      tsCache.set(b, timestamp);
    });

    for (const transfer of kept) {
      assertActive();
      fetched++;
      const observedAt = tsCache.get(transfer.blockNumber.toString())
        ?? await deps.blockTimestamp(transfer.blockNumber);
      assertActive();

      wallets.add(transfer.from);
      wallets.add(transfer.to);

      const receiptKey = arcTransferReceiptKey(transfer, chain);
      rows.push(toTransactionRow(transfer, deps.usdcContract, observedAt, chain));
      const receiptSignals = [
        buildUsdcTransferSignal({
          walletAddress: transfer.to, face: 'provider', chain,
          txHash: receiptKey, amount: transfer.amount, counterparty: transfer.from, observedAt,
        }),
        buildUsdcTransferSignal({
          walletAddress: transfer.from, face: 'consumer', chain,
          txHash: receiptKey, amount: transfer.amount, counterparty: transfer.to, observedAt,
        }),
      ];
      if (chain === 'arc-mainnet') {
        for (const signal of receiptSignals) {
          // Native value movement is observed behavior, not a signed attestation.
          signal.tier = 2;
          signal.signedBy = null;
          signal.payload = {
            ...signal.payload, source: 'arc_native_usdc_transfer',
            rawTxHash: transfer.txHash, logIndex: transfer.logIndex,
            rawAmount: String(transfer.rawAmount), emitter: transfer.emitter, decimals: transfer.decimals,
            amountDecimal: transfer.amountDecimal,
          };
        }
      }
      signals.push(...receiptSignals);
    }

    if (++windowsProcessed >= maxWindows) break;
  }

  const advanceCursor = async (): Promise<void> => {
    assertActive();
    if (maxBlock < startBlock) return;
    await deps.upsertCursor(cursorKey, String(maxBlock), Number(maxBlock));
    assertActive();
    cursors.set(cursorKey, String(maxBlock));
  };

  const coverage = arcIndexCoverage(head, startBlock, maxBlock, cursor?.last_slot ?? null, 0, stopped);
  if (fetched === 0) {
    await advanceCursor();
    return { fetched: 0, inserted: 0, cursors, coverage };
  }

  // FK: transactions references (chain, wallet_address) on wallets.
  // Insert-if-absent — never upsertWallet, which would zero live scores
  // (the 2026-08-02 clobber).
  assertActive();
  await deps.ensureWallets([...wallets]);
  assertActive();
  const inserted = await deps.insertTransactions(rows);
  assertActive();
  await deps.insertSignalEvents(signals);
  assertActive();

  await advanceCursor();
  return { fetched, inserted, cursors, coverage };
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

/** PostgREST page size for the seed reads. */
const SEED_PAGE_SIZE = 1000;

/**
 * Read every row of one seed source, paged.
 *
 * Explicitly ORDERED. A paged read with no deterministic order repeats and
 * skips rows — a first pass at the 2026-08-17 casing audit gave two different
 * splits of the same total for exactly this reason. And explicitly paged
 * because `erc8004_agents` holds 2,752 arc rows: a single unpaged read that
 * silently stops at PostgREST's page cap would truncate the seed, which fails
 * SILENTLY as "fewer matches" rather than as an error.
 */
async function fetchSeedRows<T>(
  table: 'erc8004_agents' | 'wallets',
  columns: string,
  orderBy: string,
  refine?: (query: ReturnType<typeof supabase.from>) => unknown,
): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += SEED_PAGE_SIZE) {
    let query = supabase.from(table).select(columns).eq('chain', ARC_CHAIN);
    if (refine) query = refine(query as never) as typeof query;
    const { data, error } = await query
      .order(orderBy, { ascending: true })
      .range(offset, offset + SEED_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as T[];
    out.push(...page);
    if (page.length < SEED_PAGE_SIZE) return out;
  }
}

export interface ArcSeedRows {
  registryRows: Array<{ owner: string | null; agent_wallet: string | null }>;
  walletRows: SeedWalletRow[];
}

/**
 * Read the seed set's two DB sources. Arc testnet chain key only.
 *
 * The `wallets` read is filtered SERVER-SIDE on the intentionality markers:
 * that table holds 85,874 arc rows against 781 marker-carrying ones, and
 * pulling all of them to filter in TS would be an unbounded read for no reason.
 * `buildArcSeedSet` re-applies {@link isIntentional} anyway — the filter is a
 * bandwidth decision, the gate is a correctness one, and neither stands in for
 * the other.
 *
 * Returned as rows rather than a set so a dry run can report what the
 * exclusions removed without issuing the reads twice.
 */
export async function loadArcSeedRows(): Promise<ArcSeedRows> {
  const registryRows = await fetchSeedRows<{ owner: string | null; agent_wallet: string | null }>(
    'erc8004_agents',
    'owner,agent_wallet',
    'agent_id',
  );

  const walletRows = await fetchSeedRows<SeedWalletRow>(
    'wallets',
    'address,claimed,arc_agent_id',
    'address',
    (query) => (query as unknown as { or: (f: string) => unknown })
      .or('claimed.eq.true,arc_agent_id.not.is.null'),
  );

  return { registryRows, walletRows };
}

/** The seed set as the indexer uses it. */
export async function loadArcSeedSet(): Promise<Set<string>> {
  return buildArcSeedSet(await loadArcSeedRows());
}

export interface RunArcTransfersOptions {
  signal?: AbortSignal;
  usdcContract?: string;
  windowSize?: number;
  maxWindows?: number;
  /** Swap in counting no-ops (and, for a sampled dry run, a synthetic cursor). */
  overrides?: Partial<ArcTransfersIndexerDeps>;
}

/**
 * Production indexer run. OPT-IN, mirrors arc-jobs.ts: the Arc adapter gates it
 * on ARC_TRANSFERS_START_BLOCK being truthy.
 *
 * NOTE on that env var: the PERSISTED cursor wins over it. It is only a
 * fallback for when no cursor row exists, and one does (last_slot 51,279,035,
 * banked 2026-08-10). Restoring the variable therefore resumes from there, not
 * from its value — see the spec's "The turn-on decision".
 */
export async function runArcTransfersIndexer(
  opts: RunArcTransfersOptions = {},
): Promise<ArcIndexRunResult> {
  opts.signal?.throwIfAborted();
  const rpc = <T>(read: () => Promise<T>) => { opts.signal?.throwIfAborted(); return read(); };
  const usdcContract = opts.usdcContract ?? ARC_USDC_CONTRACT;
  const client = makeClient();
  const envStartBlock = resolveTransfersStartBlockEnv();
  const seed = await loadArcSeedSet();
  opts.signal?.throwIfAborted();
  // Frozen once per run: the array handed to every getLogs call.
  const seedList = [...seed] as `0x${string}`[];

  return arcTransfersIndexer({
    usdcContract,
    seed,
    signal: opts.signal,
    windowSize: opts.windowSize,
    maxWindows: opts.maxWindows ?? ARC_TRANSFERS_DEFAULT_MAX_WINDOWS,
    timeBudgetMs: ARC_RUN_TIME_BUDGET_MS,
    getHead: async () => withRateLimitRetry(() => rpc(() => client.getBlockNumber()), INGEST_RETRY),
    getLogs: async (fromBlock, toBlock, face) => {
      // The seed goes into ONE indexed topic position per call. Positions are
      // AND-ed by the node, so `{ from: seed, to: seed }` would mean "both ends
      // seeded" — the union needs the two calls the core makes.
      const logs = await withArcLogRetry(() => rpc(() => client.getLogs({
        address: usdcContract as `0x${string}`,
        event: TRANSFER_EVENT,
        args: face === 'from' ? { from: seedList } : { to: seedList },
        fromBlock,
        toBlock,
      })), INGEST_RETRY);
      const out: ArcTransfer[] = [];
      for (const log of logs) {
        const rec = parseTransfer(log);
        if (rec) out.push(rec);
      }
      return out;
    },
    blockTimestamp: async (blockNumber) => {
      const block = await withRateLimitRetry(() => rpc(() => client.getBlock({ blockNumber })), INGEST_RETRY);
      return new Date(Number(block.timestamp) * 1000).toISOString();
    },
    insertTransactions: dbInsertTransactions,
    insertSignalEvents: dbInsertSignalEvents,
    // Insert-if-absent: never zeroes an existing wallet's live score.
    ensureWallets: dbMakeEnsureWallets(ARC_CHAIN),
    getCursor: async (key) => {
      const c = await dbGetCursor(key, ARC_CHAIN);
      if (c) return { last_signature: c.last_signature, last_slot: c.last_slot };
      return { last_signature: String(envStartBlock - 1), last_slot: envStartBlock - 1 };
    },
    upsertCursor: async (key, last, slot) => { await dbUpsertCursor(key, last, slot, ARC_CHAIN); },
    ...opts.overrides,
  });
}
