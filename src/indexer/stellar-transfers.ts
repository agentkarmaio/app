/**
 * Stellar plain USDC SAC transfer indexer (mainnet / pubnet only).
 *
 * Sibling to stellar-x402.ts, and the reason it exists: that indexer only
 * persists a receipt when the settlement tx source is a known OZ Channels
 * facilitator (STELLAR_FACILITATOR_SET) or the payee is a known MPP recipient.
 * Both sets are empty, and a probe of a real partner settlement found
 * `fee_account == source_account == the agent itself` — no fee-bump wrapper, so
 * there is no facilitator to seed. Real Soroban agents pay their own fees, so
 * the facilitator-gated path can never see them, and `transactions` held ZERO
 * rows for chain 'stellar'. This path removes the facilitator requirement.
 *
 * SCOPE IS A SEED SET, NOT A HEURISTIC. Indexing every USDC transfer on Stellar
 * is a firehose — that is why arc-transfers.ts is paused pending a "relevance
 * filter". Reads are per-seed-account Horizon walks, so Horizon applies the
 * filter server-side and a run is O(seed set), not O(chain).
 *
 * Rows feed src/scoring/reciprocity.ts, which reads BOTH directions:
 * outbound `WHERE wallet_address = W` and inbound `WHERE counterparty = W`.
 * Every row here therefore carries a real payee — a null-counterparty row is
 * invisible to the inbound lookup and makes a wallet look MORE independent than
 * it is.
 *
 *
 * Env:
 *   STELLAR_HORIZON_URL — Horizon endpoint (optional; defaults to mainnet).
 */

import type { Chain, Transaction } from '@/db/schema';
import type { IndexRunResult } from '@/chain-adapters/types';
import {
  getStellarUsdcSac,
  isStellarAccount,
  isStellarContract,
  STELLAR_SEED_EXCLUSIONS,
  STELLAR_SEED_EXTRA,
  USDC_ISSUER,
} from '@/config/stellar-x402';
import {
  insertTransactions as dbInsertTransactions,
  insertSignalEvents as dbInsertSignalEvents,
  makeEnsureWallets as dbMakeEnsureWallets,
  getCursor as dbGetCursor,
  upsertCursor as dbUpsertCursor,
  supabase,
  type InsertSignalEventInput,
} from '@/db/client';
import { withConcurrency } from '@/lib/concurrency';
import {
  extractUsdcTransfers,
  type AssetPin,
  type HorizonPaymentRecord,
  type StellarUsdcTransfer,
} from '@/lib/stellar-horizon-usdc';
import { buildUsdcTransferSignal } from '@/scoring/signals';
import { isHorizonNotFound, resolveHorizonUrl } from './stellar-activity';

const STELLAR_CHAIN = 'stellar' as Chain;

/** Horizon page size. Its documented maximum. */
export const PAGE_LIMIT = 200;

/** Pages per address per run. Matches DEFAULT_MAX_PAGES in stellar-activity.ts. */
export const MAX_PAGES_PER_ADDRESS = 5;

/** Parallel address walks. Modest — Horizon is public and unauthenticated. */
export const ADDRESS_CONCURRENCY = 4;

/** Wall-clock ceiling for a run. Mirrors ARC_RUN_TIME_BUDGET_MS. */
export const STELLAR_RUN_TIME_BUDGET_MS = 120_000;
/** Account scheduling only; never used as a Horizon historical paging token. */
export const STELLAR_TARGET_ROTATION_CURSOR_KEY = 'stellar-transfers:rotation';

// ─── Horizon record shapes ────────────────────────────────────────────────────
//
// The record shapes and the USDC decoder live in @/lib/stellar-horizon-usdc:
// the x402 Horizon backfill and the read-time independence signal decode the
// same three shapes against the same issuer pin, and three copies of that
// decision is exactly how one of them ends up dropping every Soroban
// settlement. Re-exported here so this module's surface is unchanged.

export {
  extractUsdcTransfers,
  type AssetPin,
  type HorizonBalanceChange,
  type HorizonPaymentRecord,
  type StellarUsdcTransfer,
} from '@/lib/stellar-horizon-usdc';

/**
 * Pure: map a transfer to an AK `transactions` row.
 *
 * `wallet_address` = payer, `counterparty` = payee — the invariant every
 * indexer follows (celo-x402.ts, helius.ts, arc-transfers.ts). Direction comes
 * from the operation, never from whose feed produced it, so the same transfer
 * seen from both sides yields a byte-identical row and `ignoreDuplicates` on
 * `tx_signature` collapses them.
 *
 * `facilitator` is the USDC SAC, mirroring arc-transfers.ts's use of the token
 * contract: there is no facilitator in this flow, and recording the tx source
 * (which IS the agent here) would misreport a self-submitted payment as routed.
 *
 * StrKey is passed through byte-for-byte. The lowercasing in arc-transfers.ts
 * is EVM-scoped; applying it here would reproduce the 2026-08-17 Arc casing
 * split in reverse.
 */
export function toTransactionRow(
  transfer: StellarUsdcTransfer,
  sac: string,
): Omit<Transaction, 'id'> {
  return {
    chain: STELLAR_CHAIN,
    wallet_address: transfer.from,
    facilitator: sac,
    counterparty: transfer.to,
    amount: transfer.amount,
    timestamp: transfer.createdAt,
    success: transfer.successful,
    tx_signature: transfer.txHash,
  };
}

// ─── Seed set ─────────────────────────────────────────────────────────────────

/**
 * A `wallets` row, with the two markers that distinguish an intentional AK
 * relationship from a row this very indexer minted. See {@link isIntentional}.
 */
export interface SeedWalletRow {
  address?: string | null;
  /** The operator claimed this wallet through AK's claim flow. */
  claimed?: boolean | null;
  /** The wallet is bound to an ERC-8004 agent on Stellar's IdentityRegistry. */
  stellar_agent_id?: number | null;
}

/**
 * Does this `wallets` row represent a relationship someone deliberately
 * established with AgentKarma?
 *
 * THIS GATE EXISTS TO BREAK A FEEDBACK LOOP, not to be tidy. `walkAddress`
 * calls `ensureWallets` for BOTH faces of every transfer it keeps, minting a
 * `wallets` row for each counterparty — seeded or not. If the seed set then
 * read every `wallets` row, run N's counterparties would become run N+1's walk
 * targets: a transitive closure over the USDC payment graph, one hop per run.
 * Within a few 6-hourly ticks the walk reaches exchange hot wallets and
 * anchors, which is the firehose this whole design exists to avoid — arriving
 * through the back door rather than the front.
 *
 * A minted row has `claimed = false` (the column default) and a NULL
 * `stellar_agent_id`, so it never qualifies and the loop cannot start.
 *
 * `score > 0` is deliberately NOT a marker: this indexer's own rows put a
 * minted wallet on the rescore queue, so scoring would readmit it next run.
 */
export function isIntentional(row: SeedWalletRow): boolean {
  return row.claimed === true || row.stellar_agent_id != null;
}

export interface SeedSetInput {
  /** `erc8004_agents` rows for chain 'stellar'. BOTH columns are taken. */
  registryRows?: ReadonlyArray<{ owner?: string | null; agent_wallet?: string | null }>;
  /**
   * `wallets` rows for chain 'stellar'. Only rows passing {@link isIntentional}
   * are seeded — `wallets` is open-membership and this indexer writes into it.
   */
  walletRows?: ReadonlyArray<SeedWalletRow>;
  /** Explicitly-added partner agents. Defaults to STELLAR_SEED_EXTRA. */
  extra?: readonly string[];
  /** Overridable for tests. Defaults to STELLAR_SEED_EXCLUSIONS. */
  exclusions?: ReadonlySet<string>;
}

/**
 * Pure: build the set of addresses AgentKarma already cares about.
 *
 * THE single place scope is decided — extend it here, never by loosening a
 * filter in the indexer core.
 *
 * Sources are unioned, then two gates apply:
 *   - shape: `G…` accounts and `C…` contracts only. This also drops the six
 *     malformed demo-fixture rows sitting in `wallets` today at no extra cost.
 *   - exclusions: asset infrastructure (the USDC issuer, the SAC). See
 *     STELLAR_SEED_EXCLUSIONS for why that is load-bearing rather than tidy.
 *
 * Contracts stay in the SET (they can be a counterparty) but are never walk
 * targets — Horizon has no `/accounts/{C…}` endpoint. See {@link walkTargets}.
 */
export function buildStellarSeedSet(input: SeedSetInput = {}): Set<string> {
  const exclusions = input.exclusions ?? STELLAR_SEED_EXCLUSIONS;
  const seed = new Set<string>();

  const add = (address: string | null | undefined): void => {
    if (!address) return;
    // Shape gate. StrKey is case-SENSITIVE — never normalize the case.
    if (!isStellarAccount(address) && !isStellarContract(address)) return;
    if (exclusions.has(address)) return;
    seed.add(address);
  };

  for (const row of input.registryRows ?? []) {
    // BOTH faces: either can be the payment side. (scripts/stellar-backfill-
    // behavior.ts uses `agent_wallet ?? owner`; that loses one of them.)
    add(row.owner);
    add(row.agent_wallet);
  }
  // Marker gate — breaks the mint→seed→walk feedback loop. See isIntentional().
  for (const row of input.walletRows ?? []) {
    if (!isIntentional(row)) continue;
    add(row.address);
  }
  for (const address of input.extra ?? STELLAR_SEED_EXTRA) add(address);

  return seed;
}

/**
 * The subset of a seed set that can actually be walked: `G…` accounts only.
 * Horizon exposes no `/accounts/{C…}` endpoint, so a contract in the seed set
 * is matchable as a counterparty but never a feed.
 */
export function walkTargets(seed: ReadonlySet<string>): string[] {
  return [...seed].filter((address) => isStellarAccount(address));
}

// ─── DI core ──────────────────────────────────────────────────────────────────

export interface StellarTransfersDeps {
  signal?: AbortSignal;
  /** Everything AK cares about — matched against both sides of a transfer. */
  seed: ReadonlySet<string>;
  /** Accounts whose Horizon feed is walked. Usually walkTargets(seed). */
  walkTargets: string[];
  asset: AssetPin;
  /** USDC SAC contract id, recorded as the row's `facilitator`. */
  sac: string;
  fetchPayments: (
    address: string,
    cursor: string | null,
    limit: number,
  ) => Promise<{ records: HorizonPaymentRecord[] }>;
  insertTransactions: (rows: Omit<Transaction, 'id'>[]) => Promise<number>;
  insertSignalEvents: (inputs: InsertSignalEventInput[]) => Promise<number>;
  ensureWallets: (addresses: string[]) => Promise<void>;
  getCursor: (key: string) => Promise<{ last_signature: string; last_slot: number | null } | null>;
  upsertCursor: (key: string, lastSignature: string, lastSlot?: number) => Promise<void>;
  /** Fair scheduling checkpoint, separate from each account's history cursor. */
  readTargetCheckpoint?: () => Promise<string | null>;
  writeTargetCheckpoint?: (address: string) => Promise<void>;
  pageLimit?: number;
  maxPagesPerAddress?: number;
  concurrency?: number;
  /** Wall-clock ceiling. Omit for unbounded (what the DI tests rely on). */
  timeBudgetMs?: number;
  /** Injected clock so the budget is testable without real waiting. */
  now?: () => number;
}

export interface StellarTransfersRunResult extends IndexRunResult {
  coverage: {
    complete: boolean;
    head?: string;
    checkpoint?: string | null;
    checked: number;
    pending: number;
    unresolved: number;
    reason?: string;
  };
  /** Seed addresses Horizon 404s on — a permanent, expected steady state. */
  absent: string[];
  /** Seed addresses whose walk errored for any other reason. */
  failed: string[];
  /** How many accounts were walked. Lets a caller detect an all-absent run. */
  walked: number;
}

/** Cursor key namespaced per address, distinct from stellar-x402's `stellar:<SAC>`. */
export function stellarTransfersCursorKey(address: string): string {
  return `stellar-transfers:${address}`;
}

interface AddressOutcome {
  address: string;
  status: 'ok' | 'absent' | 'failed' | 'pending';
  /** True once a request or cursor read was attempted. */
  checked: boolean;
  complete: boolean;
  fetched: number;
  inserted: number;
  cursor?: string;
}

/**
 * Walk one seed account's Horizon payment feed and persist what belongs to AK.
 *
 * Cursor discipline: the cursor advances only after this address's rows,
 * signals and wallet rows are committed. A record deliberately skipped (wrong
 * asset, self-transfer, neither side seeded) counts as processed and may be
 * passed; a fetch or write failure banks nothing, so the next run re-reads the
 * same records — safe, because every write is idempotent.
 */
async function walkAddress(
  deps: StellarTransfersDeps,
  address: string,
  deadline: number,
  now: () => number,
  seenTxHashes: Set<string>,
): Promise<AddressOutcome> {
  deps.signal?.throwIfAborted();
  if (now() >= deadline) {
    return { address, status: 'pending', checked: false, complete: false, fetched: 0, inserted: 0 };
  }
  const pageLimit = deps.pageLimit ?? PAGE_LIMIT;
  const maxPages = deps.maxPagesPerAddress ?? MAX_PAGES_PER_ADDRESS;
  const cursorKey = stellarTransfersCursorKey(address);

  let cursor: string | null = null;
  try {
    const persisted = await deps.getCursor(cursorKey);
    deps.signal?.throwIfAborted();
    if (persisted?.last_signature) cursor = persisted.last_signature;
  } catch (err) {
    deps.signal?.throwIfAborted();
    console.error(`[stellar-transfers] cursor read failed for ${address}:`, err);
    return { address, status: 'failed', checked: true, complete: false, fetched: 0, inserted: 0 };
  }

  const rows: Omit<Transaction, 'id'>[] = [];
  const signals: InsertSignalEventInput[] = [];
  const wallets = new Set<string>();
  let lastProcessedToken: string | null = null;
  let complete = false;
  let checked = false;

  for (let page = 0; page < maxPages; page++) {
    deps.signal?.throwIfAborted();
    if (now() >= deadline) break;

    let records: HorizonPaymentRecord[];
    try {
      checked = true;
      const result = await deps.fetchPayments(address, cursor, pageLimit);
      deps.signal?.throwIfAborted();
      records = result.records;
    } catch (err) {
      deps.signal?.throwIfAborted();
      if (isHorizonNotFound(err)) {
        // A registry agent can reference an account never funded on mainnet.
        // A permanent 404 is an expected steady state, not a failure — paging
        // on it every 6h forever was the 2026-08-26 incident.
        return { address, status: 'absent', checked: true, complete: true, fetched: 0, inserted: 0 };
      }
      console.error(`[stellar-transfers] page fetch failed for ${address}:`, err);
      // Keep nothing banked for this address: the cursor stays where it was.
      return { address, status: 'failed', checked: true, complete: false, fetched: 0, inserted: 0 };
    }

    if (records.length === 0) { complete = true; break; }

    for (const record of records) {
      deps.signal?.throwIfAborted();
      // Processed — whether or not it produced a row.
      lastProcessedToken = record.paging_token;

      // Self-movements never reach here: extractUsdcTransfers drops them, so
      // no row can carry a counterparty that normalizes to null.
      for (const transfer of extractUsdcTransfers(record, deps.asset)) {
        // Seed scope. Not redundant with the per-account feed: a Soroban invoke
        // can carry legs between two third parties.
        if (!deps.seed.has(transfer.from) && !deps.seed.has(transfer.to)) continue;
        if (seenTxHashes.has(transfer.txHash)) continue;
        seenTxHashes.add(transfer.txHash);

        rows.push(toTransactionRow(transfer, deps.sac));
        wallets.add(transfer.from);
        wallets.add(transfer.to);
        signals.push(
          buildUsdcTransferSignal({
            walletAddress: transfer.to, face: 'provider', chain: STELLAR_CHAIN,
            txHash: transfer.txHash, amount: transfer.amount,
            counterparty: transfer.from, observedAt: transfer.createdAt,
          }),
          buildUsdcTransferSignal({
            walletAddress: transfer.from, face: 'consumer', chain: STELLAR_CHAIN,
            txHash: transfer.txHash, amount: transfer.amount,
            counterparty: transfer.to, observedAt: transfer.createdAt,
          }),
        );
      }
    }

    cursor = records[records.length - 1].paging_token;
    // A short page means the feed is exhausted.
    if (records.length < pageLimit) { complete = true; break; }
  }

  if (lastProcessedToken === null) {
    return { address, status: complete ? 'ok' : 'pending', checked, complete, fetched: 0, inserted: 0 };
  }

  let inserted = 0;
  try {
    if (rows.length > 0) {
      // FK: transactions references (chain, wallet_address) on wallets.
      // Insert-if-absent — never upsertWallet, which would zero live scores
      // (the 2026-08-02 clobber).
      deps.signal?.throwIfAborted();
      await deps.ensureWallets([...wallets]);
      deps.signal?.throwIfAborted();
      inserted = await deps.insertTransactions(rows);
      deps.signal?.throwIfAborted();
      await deps.insertSignalEvents(signals);
      deps.signal?.throwIfAborted();
    }
  } catch (err) {
    deps.signal?.throwIfAborted();
    console.error(`[stellar-transfers] write failed for ${address}:`, err);
    // Cursor NOT advanced — the next run re-reads these records.
    return { address, status: 'failed', checked: true, complete: false, fetched: 0, inserted: 0 };
  }

  // last_slot stays undefined: a paging_token (~2.7e17) exceeds both an INTEGER
  // column and Number.MAX_SAFE_INTEGER, so storing it there would corrupt it.
  try {
    deps.signal?.throwIfAborted();
    await deps.upsertCursor(cursorKey, lastProcessedToken);
    deps.signal?.throwIfAborted();
  } catch (err) {
    deps.signal?.throwIfAborted();
    console.error(`[stellar-transfers] cursor write failed for ${address}:`, err);
    return { address, status: 'failed', checked, complete: false, fetched: rows.length, inserted };
  }

  return { address, status: complete ? 'ok' : 'pending', checked, complete, fetched: rows.length, inserted, cursor: lastProcessedToken };
}

/**
 * Index USDC transfers for every walk target. Pure orchestration over injected
 * IO, mirroring arcTransfersIndexer's shape.
 */
export async function stellarTransfersIndexer(
  deps: StellarTransfersDeps,
): Promise<StellarTransfersRunResult> {
  deps.signal?.throwIfAborted();
  const cursors = new Map<string, string>();
  const now = deps.now ?? Date.now;
  const deadline = deps.timeBudgetMs != null ? now() + deps.timeBudgetMs : Number.POSITIVE_INFINITY;
  const concurrency = deps.concurrency ?? ADDRESS_CONCURRENCY;
  let targets = deps.walkTargets;
  if (deps.readTargetCheckpoint) {
    const checkpoint = await deps.readTargetCheckpoint();
    deps.signal?.throwIfAborted();
    const sorted = [...new Set(targets)].sort();
    const next = checkpoint == null ? 0 : sorted.findIndex((address) => address > checkpoint);
    const pivot = next < 0 ? 0 : next;
    targets = [...sorted.slice(pivot), ...sorted.slice(0, pivot)];
  }

  /**
   * Run-level, deliberately not per-address. `tx_signature` is UNIQUE, so at
   * most one row per transaction can ever land — and a transfer A→B appears in
   * BOTH A's and B's Horizon feed. Deduplicating per address would emit two
   * identical rows, the DB would silently swallow one, and `fetched` would
   * overstate what was persisted.
   *
   * Safe to share across the concurrent walks: `withConcurrency` interleaves on
   * one event loop, so there is no torn read. And a claim is never lost — if
   * the claiming address's write fails its cursor does not advance, so the next
   * run re-reads that record.
   */
  const seenTxHashes = new Set<string>();

  const outcomes = await withConcurrency(
    targets,
    concurrency,
    (address) => walkAddress(deps, address, deadline, now, seenTxHashes),
  );

  deps.signal?.throwIfAborted();
  let fetched = 0;
  let inserted = 0;
  const absent: string[] = [];
  const failed: string[] = [];

  for (const outcome of outcomes) {
    fetched += outcome.fetched;
    inserted += outcome.inserted;
    if (outcome.status === 'absent') absent.push(outcome.address);
    if (outcome.status === 'failed') failed.push(outcome.address);
    if (outcome.cursor) cursors.set(stellarTransfersCursorKey(outcome.address), outcome.cursor);
  }

  // Scheduling is independent of historical progress: an attempted account
  // rotates even when it failed, so one slow broken feed cannot starve the
  // others. Failure stays explicit and its historical cursor stays held.
  // An unattempted account never becomes a scheduling checkpoint.
  const lastChecked = outcomes.filter((o) => o.checked).at(-1);
  if (lastChecked && deps.writeTargetCheckpoint) await deps.writeTargetCheckpoint(lastChecked.address);
  deps.signal?.throwIfAborted();
  const checked = outcomes.filter((o) => o.checked).length;
  const pending = outcomes.filter((o) => o.status === 'pending').length;
  const allAbsent = checked > 0 && absent.length === checked && pending === 0;
  const unresolved = allAbsent ? absent.length : failed.length;
  const reason = targets.length === 0 ? 'empty_seed'
    : allAbsent ? 'all_absent'
      : failed.length > 0 ? 'address_failure'
        : pending > 0 ? 'scan_limit' : undefined;
  return {
    fetched, inserted, cursors, absent, failed, walked: checked,
    coverage: {
      complete: targets.length > 0 && pending === 0 && unresolved === 0,
      checked, pending, unresolved, ...(lastChecked ? { checkpoint: lastChecked.address } : {}), ...(reason ? { reason } : {}),
    },
  };
}

// ─── Production wiring ────────────────────────────────────────────────────────

/** Read the seed set's two DB sources. Mainnet chain key only. */
export async function loadStellarSeedSet(signal?: AbortSignal): Promise<Set<string>> {
  signal?.throwIfAborted();
  const { data: registryRows, error: registryErr } = await supabase
    .from('erc8004_agents')
    .select('owner,agent_wallet')
    .eq('chain', STELLAR_CHAIN);
  signal?.throwIfAborted();
  if (registryErr) throw registryErr;

  // The two marker columns come back with the address so buildStellarSeedSet
  // can drop rows this indexer minted itself (isIntentional).
  const { data: walletRows, error: walletErr } = await supabase
    .from('wallets')
    .select('address,claimed,stellar_agent_id')
    .eq('chain', STELLAR_CHAIN);
  signal?.throwIfAborted();
  if (walletErr) throw walletErr;

  return buildStellarSeedSet({
    registryRows: (registryRows ?? []) as Array<{ owner: string | null; agent_wallet: string | null }>,
    walletRows: (walletRows ?? []) as SeedWalletRow[],
  });
}

/** Real Horizon page read. `order=asc` so the cursor only moves forward. */
async function horizonFetchPayments(
  address: string,
  cursor: string | null,
  limit: number,
  signal?: AbortSignal,
): Promise<{ records: HorizonPaymentRecord[] }> {
  signal?.throwIfAborted();
  const base = resolveHorizonUrl();
  const url = new URL(`${base}/accounts/${address}/payments`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('order', 'asc');
  if (cursor) url.searchParams.set('cursor', cursor);

  const res = await fetch(url.toString(), {
    headers: { accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  signal?.throwIfAborted();
  if (!res.ok) {
    // Status-tagged so isHorizonNotFound() can branch on 404 without matching
    // message text (the 2026-08-26 fix).
    throw Object.assign(new Error(`Horizon ${res.status} ${res.statusText} for ${url.toString()}`), {
      status: res.status,
    });
  }
  const body = (await res.json()) as { _embedded?: { records?: HorizonPaymentRecord[] } };
  signal?.throwIfAborted();
  return { records: body._embedded?.records ?? [] };
}

export interface RunStellarTransfersOptions {
  signal?: AbortSignal;
  maxPagesPerAddress?: number;
  concurrency?: number;
  /** Swap in counting no-ops for a read-only dry run. */
  overrides?: Partial<StellarTransfersDeps>;
}

/**
 * Production run. PUBNET ONLY — deliberately no network parameter.
 *
 * Testnet rows written under `chain: 'stellar'` would pollute mainnet
 * reputation, and a separate testnet chain key is an unapproved decision.
 */
export async function runStellarTransfersIndexer(
  opts: RunStellarTransfersOptions = {},
): Promise<StellarTransfersRunResult> {
  opts.signal?.throwIfAborted();
  const sac = getStellarUsdcSac('pubnet');
  const seed = await loadStellarSeedSet(opts.signal);

  return stellarTransfersIndexer({
    signal: opts.signal,
    seed,
    walkTargets: walkTargets(seed),
    asset: { code: 'USDC', issuer: USDC_ISSUER.pubnet },
    sac,
    maxPagesPerAddress: opts.maxPagesPerAddress,
    concurrency: opts.concurrency,
    timeBudgetMs: STELLAR_RUN_TIME_BUDGET_MS,
    fetchPayments: (address, cursor, limit) => horizonFetchPayments(address, cursor, limit, opts.signal),
    insertTransactions: dbInsertTransactions,
    insertSignalEvents: dbInsertSignalEvents,
    // Insert-if-absent: never zeroes an existing wallet's live score.
    ensureWallets: dbMakeEnsureWallets(STELLAR_CHAIN),
    getCursor: async (key) => {
      const c = await dbGetCursor(key, STELLAR_CHAIN);
      return c ? { last_signature: c.last_signature, last_slot: c.last_slot } : null;
    },
    upsertCursor: async (key, last, slot) => { await dbUpsertCursor(key, last, slot, STELLAR_CHAIN); },
    readTargetCheckpoint: async () => (await dbGetCursor(STELLAR_TARGET_ROTATION_CURSOR_KEY, STELLAR_CHAIN))?.last_signature ?? null,
    writeTargetCheckpoint: (address) => dbUpsertCursor(STELLAR_TARGET_ROTATION_CURSOR_KEY, address, undefined, STELLAR_CHAIN),
    ...opts.overrides,
  });
}
