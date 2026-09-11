/**
 * Solana plain USDC transfer indexer, scoped by a seed set of provider wallets.
 *
 * Sibling to src/indexer/index.ts (facilitator-keyed) and wallet-scan.ts
 * (wallet-keyed but facilitator-GATED). Neither of those can see this traffic,
 * and that gate is the whole problem: `extractX402PaymentForWallet` persists a
 * payment only when the destination is a known facilitator, so a provider
 * paying an LLM API, a data vendor, or a subcontractor agent produces no row at
 * all. 377 of 1,217 recent Solana payees (31%) therefore have ZERO rows where
 * they are the payer, and `enrichment.independence` correctly answers
 * `insufficient-data` for every one of them — there is nothing to be reciprocal
 * with.
 *
 * Same structural hole `stellar-transfers.ts` and `arc-transfers.ts` were built
 * to close on their chains; this is the third instance. The answer is an
 * additive second path with the facilitator requirement removed — never a
 * loosened gate on the existing one, and never a weakened COVERAGE_FLOOR.
 *
 * SCOPE IS A SEED SET, NOT A HEURISTIC. Indexing every USDC transfer on Solana
 * is a firehose; that is why arc-transfers.ts was paused for a month. Reads here
 * are per-seed-address `getSignaturesForAddress` walks, so the filter is applied
 * by the node and a run is O(seed set), not O(chain).
 *
 * THE SCAN KEY IS THE OWNER ADDRESS, NOT THE USDC TOKEN ACCOUNT. Measured
 * 2026-09-10: the owner is the SPL transfer authority, so it appears in
 * `accountKeys` for every payment it signs — one wallet's ENTIRE outbound
 * history (6 payments, 6 payees) was recovered from a 12-signature owner feed
 * whose USDC ATA feed held ≥1000 signatures. The ATA's extra content is
 * INBOUND, which the facilitator path already records. Scanning it would cost
 * ~80× for zero additional outbound. See the spec's Measurement 6 — the
 * apparent counter-evidence was a confound (sinks look identical to a blind
 * instrument).
 *
 * Rows feed src/scoring/reciprocity.ts, which reads BOTH directions: outbound
 * `WHERE wallet_address = W` and inbound `WHERE counterparty = W`. Every row
 * here therefore carries a real payee — a null-counterparty row is invisible to
 * the inbound lookup and makes a wallet look MORE independent than it is.
 *
 * Writes `transactions` AND `signal_events`, mirroring both siblings — but for
 * the SEEDED FACE ONLY (see {@link solanaTransfersIndexer}), which is where
 * this departs from them and why.
 *
 * Spec: (design notes, kept out of this repo)
 */

import type { Chain, Transaction } from '@/db/schema';
import type { IndexRunResult } from '@/chain-adapters/types';
import {
  ALL_FACILITATOR_ADDRESSES,
  ALL_FACILITATOR_ADDRESSES_SET,
  USDC_MINT,
} from '../config/facilitators';

import {
  insertTransactions as dbInsertTransactions,
  insertSignalEvents as dbInsertSignalEvents,
  markWalletsDirty as dbMarkWalletsDirty,
  withTransientDbRetry,
  makeEnsureWallets as dbMakeEnsureWallets,
  getCursor as dbGetCursor,
  upsertCursor as dbUpsertCursor,
  supabase,
  type InsertSignalEventInput,
} from '@/db/client';
import { withConcurrency } from '@/lib/concurrency';
import { INGEST_RETRY, withRateLimitRetry } from '@/lib/rpc-retry';
import { buildUsdcTransferSignal } from '@/scoring/signals';
import {
  ARCHIVE_RETRY_BUDGET,
  getArchiveRpcUrl,
  parseTransactionsBatch as defaultParseTransactionsBatch,
  type HeliusEnhancedTransaction,
  type ParseBatchResult,
} from './helius';
import { Connection, PublicKey } from '@solana/web3.js';

const SOLANA_CHAIN = 'solana' as Chain;

/**
 * Signatures per `getSignaturesForAddress` page — PINNED TO THE ARCHIVE BUDGET,
 * and that coupling is load-bearing rather than tidy.
 *
 * This is a HISTORICAL walk: every signature is weeks or months old, and the
 * primary RPC (`SOLANA_RPC_URL`, publicnode) prunes at ~2 days. So the realistic
 * case is that a page misses on the primary ENTIRELY and every signature has to
 * come from the archive. `parseWithArchiveFallback` retries misses OLDEST-FIRST
 * and caps them at `ARCHIVE_RETRY_BUDGET`, so a page LARGER than that budget
 * leaves its NEWEST signatures unresolved.
 *
 * That is fatal here, not merely lossy. `walkWallet` walks newest-first and
 * stops at the first unresolved signature (correct: a backwards-only walk must
 * never bank a cursor below a gap). With an over-budget page the first
 * unresolved signature is `signatures[0]` — so no cursor is ever banked, and the
 * wallet is stuck on the same page forever, reporting zero rows. The wallets it
 * would silently strand are exactly the high-activity ones (516 and ≥1000
 * signature feeds in the sampled population).
 *
 * A DI test cannot catch this: it lives in the production wiring, between two
 * modules that are each individually correct. `solana-transfers.test.ts` pins
 * the invariant statically instead.
 */
export const PAGE_SIZE = ARCHIVE_RETRY_BUDGET;

/**
 * Signatures walked per wallet per run, newest-first.
 *
 * This bounds a RUN, not the wallet's history. The cursor resumes where the last
 * run stopped, so repeated runs walk the whole feed — 200 deeper each time. It
 * is a rate limiter against a ~0.6 req/s archive, not a sampling decision.
 *
 * For the providers this job exists to unblock it is moot anyway: measured owner
 * feeds ran 1, 2, 6, 7, 11, 12, 23, 48 signatures — their entire history in a
 * single run.
 */
export const MAX_SIGNATURES = 200;

/**
 * Parallel wallet walks. ONE, deliberately.
 *
 * Measured 2026-09-10 on `api.mainnet-beta.solana.com`: raising concurrency made
 * throughput WORSE — 10 sequential `getParsedTransaction` calls ran at 0.6
 * req/s, while 2-way concurrency dropped to 0.3 as internal 429 retries
 * multiplied. Archive fetches are already serialized process-wide inside
 * `parseWithArchiveFallback`, so a second walker only adds contention on
 * `getSignaturesForAddress`.
 */
export const ADDRESS_CONCURRENCY = 1;

/**
 * Wall-clock ceiling for a run. Half an hour, NOT the siblings' 2 minutes.
 *
 * Those budgets are sized for a 6-hourly cron. This is a manual historical
 * backfill against a ~0.6 req/s archive endpoint: a single full-miss page of
 * {@link PAGE_SIZE} signatures costs ~3 minutes on its own, so a 2-minute
 * ceiling would end most runs mid-first-page.
 */
export const SOLANA_RUN_TIME_BUDGET_MS = 30 * 60_000;

/**
 * Routers that behave as facilitators without being declared as any.
 *
 * These surfaced only because the closure guard was fixed: both appear as
 * `facilitator` on real rows while being absent from the auto-generated
 * `SOLANA_FACILITATORS`, so the corrected seed admits them as "providers".
 * Measured across every Solana row, 2026-09-10:
 *
 * | address          | rows as facilitator | as payee | as payer |
 * |------------------|--------------------:|---------:|---------:|
 * | BcdwLA62UP…      | 2,207 (853 payees)  |       63 |    **0** |
 * | Cs2zdfUNon…      | 1,295 (19 payees)   |    1,560 |    **0** |
 *
 * NEITHER HAS EVER BEEN A PAYER. `Cs2zdfUNon…` takes from 749 addresses and
 * forwards to 19; `BcdwLA62UP…` fans out to 853 payees, the widest on the chain.
 * That is a funnel, not a business — and walking one would record its 749 payers
 * as customers and its 19 payees as vendors, when it is the thing standing
 * between them. Exactly why declared facilitators are excluded; these simply
 * were not on the list.
 *
 * This is a JUDGEMENT from a fan-out ratio, not a protocol fact, so it is a
 * named list with its evidence attached rather than a heuristic. A heuristic
 * ("exclude anything with >N payees and 0 outbound") would silently catch real
 * high-volume providers as the chain grows. If one of these is ever shown to be
 * a genuine resource server, delete the line.
 */
export const UNDECLARED_ROUTERS: readonly string[] = [
  'BcdwLA62UPEAvRn7AWauMUXKtYMXxdLzTPaSQg5tNaFc',
  'Cs2zdfUNonRdRGsiZUQQLdTxzxVvJZmgiX2mpLYKuEqP',
];

/**
 * Addresses that are asset or protocol INFRASTRUCTURE, never a payment
 * counterparty. Checked against the payee of every transfer AND subtracted from
 * the seed set — the two checks do not subsume each other, exactly as in
 * arc-transfers.ts:
 *
 *   - Subtracting from the seed stops us walking them.
 *   - Checking per-transfer stops a SEEDED provider's payment TO one of them
 *     being recorded as a counterparty relationship.
 *
 * The facilitators are here for a second reason beyond infrastructure: a
 * provider paying a facilitator is an x402 receipt, and that transaction is the
 * other path's row. `insertTransactions` upserts `ignoreDuplicates` on
 * `tx_signature`, so a collision is dropped rather than clobbered either way —
 * but whoever runs FIRST wins the row, and the x402 path's attribution is the
 * better one. Rejecting here makes the two paths disjoint by construction
 * instead of by scheduling luck.
 */
export const SOLANA_TRANSFER_EXCLUSIONS: ReadonlySet<string> = new Set<string>([
  USDC_MINT,
  ...ALL_FACILITATOR_ADDRESSES,
  ...UNDECLARED_ROUTERS,
]);


/**
 * Base58, 32–44 characters. Excludes `0`, `O`, `I`, `l` by construction, which
 * is what makes it a real gate rather than a length check.
 */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ─── The write guard ──────────────────────────────────────────────────────────

/** Why a USDC debit did not become a row. Each reason is counted separately. */
export type SkipReason =
  | 'failed-tx'
  | 'no-debit'
  | 'swap'
  | 'no-payee'
  | 'facilitator-routed'
  | 'excluded-payee';

export type DebitDecision =
  | { action: 'row'; counterparty: string; amount: number; multiCredit: boolean }
  | { action: 'skip'; reason: SkipReason };

interface OwnerDelta {
  owner: string;
  mint: string;
  raw: bigint;
  decimals: number;
}

/** Flatten `accountData` into signed per-(owner, mint) balance deltas. */
function readDeltas(tx: HeliusEnhancedTransaction): OwnerDelta[] {
  const out: OwnerDelta[] = [];
  for (const entry of tx.accountData ?? []) {
    for (const change of entry.tokenBalanceChanges ?? []) {
      const raw = BigInt(change.rawTokenAmount?.tokenAmount ?? '0');
      if (raw === BigInt(0)) continue;
      out.push({
        owner: change.userAccount,
        mint: change.mint,
        raw,
        decimals: change.rawTokenAmount?.decimals ?? 6,
      });
    }
  }
  return out;
}

/**
 * Decide whether one transaction is a USDC payment BY `wallet` TO someone else.
 *
 * Reads balance deltas, deliberately NOT `tokenTransfers`: that view pairs each
 * receiver with the largest sender of the same mint, which is a heuristic, and
 * a heuristic is exactly what must not decide who a wallet paid.
 *
 * NEVER INVENTS A PAYEE. Every rejection returns a reason, never a value. There
 * is no fallback counterparty. A transaction we cannot establish produces no
 * row, which leaves the wallet exactly as it was — the failure mode is "no
 * evidence", never "wrong evidence".
 */
export function classifyUsdcDebit(
  tx: HeliusEnhancedTransaction,
  wallet: string,
  exclusions: ReadonlySet<string> = SOLANA_TRANSFER_EXCLUSIONS,
): DebitDecision {
  // Only successful settlements are receipts.
  if (tx.transactionError !== null) return { action: 'skip', reason: 'failed-tx' };

  const deltas = readDeltas(tx);
  const usdc = deltas.filter((d) => d.mint === USDC_MINT);

  // NET the wallet's USDC movement across all of its token accounts. A move
  // between two accounts the wallet owns nets to zero and is correctly read as
  // "spent nothing" rather than as a payment to itself.
  let walletNet = BigInt(0);
  let decimals = 6;
  for (const d of usdc) {
    if (d.owner !== wallet) continue;
    walletNet += d.raw;
    decimals = d.decimals;
  }
  if (walletNet >= BigInt(0)) return { action: 'skip', reason: 'no-debit' };

  // A DEX swap: the wallet handed over USDC and received a different token. The
  // largest non-owner USDC credit is a pool vault, and recording it would make
  // an AMM look like a customer. Same rule as the Stellar self-swap drop.
  if (deltas.some((d) => d.owner === wallet && d.mint !== USDC_MINT && d.raw > BigInt(0))) {
    return { action: 'skip', reason: 'swap' };
  }

  // Sum credits PER OWNER: one payee holding two token accounts is one payee,
  // not a multi-leg payout.
  const credited = new Map<string, bigint>();
  for (const d of usdc) {
    if (d.owner === wallet || d.raw <= BigInt(0)) continue;
    credited.set(d.owner, (credited.get(d.owner) ?? BigInt(0)) + d.raw);
  }
  // Nothing received it: a burn, or a move to an account we could not attribute.
  if (credited.size === 0) return { action: 'skip', reason: 'no-payee' };

  const [counterparty, raw] = [...credited.entries()].sort((a, b) => (a[1] > b[1] ? -1 : 1))[0];

  if (ALL_FACILITATOR_ADDRESSES_SET.has(counterparty)) {
    return { action: 'skip', reason: 'facilitator-routed' };
  }
  if (exclusions.has(counterparty)) return { action: 'skip', reason: 'excluded-payee' };

  return {
    action: 'row',
    counterparty,
    // The LEG's amount, not the wallet's full debit. Attributing a batched
    // payout entirely to its largest recipient would overstate that one
    // relationship — see the multiCredit note below.
    amount: Number(raw) / 10 ** decimals,
    /**
     * `tx_signature` is UNIQUE, so a batched payout can only ever be one row and
     * the other legs are lost. Measured at 2 of 14 payments (14%) on the sampled
     * population. The bias is toward UNDER-stating `reciprocalShare` (a payee we
     * never learn about cannot match an inbound payer), so a wallet reads as
     * MORE independent than it is. Coverage is unaffected, so the gate will not
     * catch it — which is why the run reports the count.
     */
    multiCredit: credited.size > 1,
  };
}

/**
 * Pure: map an accepted decision to an AK `transactions` row.
 *
 * `wallet_address` = payer, `counterparty` = payee — the invariant every
 * indexer follows (helius.ts, celo-x402.ts, arc-transfers.ts,
 * stellar-transfers.ts).
 *
 * `facilitator` is the USDC mint, mirroring arc-transfers.ts's use of
 * ARC_USDC_CONTRACT and stellar-transfers.ts's use of the SAC: there is no
 * facilitator in this flow, and recording the transaction's fee payer (which IS
 * the agent here) would misreport a self-submitted payment as routed.
 *
 * Base58 passes through byte-for-byte. The lowercasing in arc-transfers.ts is
 * EVM-scoped; applying it here would reproduce the 2026-08-17 Arc casing split
 * in reverse, orphaning every row from its wallet.
 */
export function toTransactionRow(
  decision: Extract<DebitDecision, { action: 'row' }>,
  wallet: string,
  tx: HeliusEnhancedTransaction,
): Omit<Transaction, 'id'> {
  return {
    chain: SOLANA_CHAIN,
    wallet_address: wallet,
    facilitator: USDC_MINT,
    counterparty: decision.counterparty,
    amount: decision.amount,
    timestamp: new Date(tx.timestamp * 1000).toISOString(),
    success: true,
    tx_signature: tx.signature,
  };
}

// ─── The seed set ─────────────────────────────────────────────────────────────

/** One `transactions` row, read only for the two columns scope depends on. */
export interface SeedPayeeRow {
  counterparty?: string | null;
  /**
   * Present so the closure guard is expressible. A row THIS indexer wrote
   * carries `facilitator = USDC_MINT`, and that is the ONLY value the guard
   * excludes — see {@link buildSolanaSeedSet} for why an allowlist of known
   * facilitators is the wrong shape here. Absent means "caller already filtered
   * server-side".
   */
  facilitator?: string | null;
}

export interface SeedSetInput {
  /** Distinct payees observed on recent Solana rows. */
  payeeRows?: ReadonlyArray<SeedPayeeRow>;
  /** Overridable for tests. Defaults to SOLANA_TRANSFER_EXCLUSIONS. */
  exclusions?: ReadonlySet<string>;
}

/**
 * Pure: build the set of provider wallets in scope.
 *
 * THE single place scope is decided — extend it here, never by loosening a
 * filter in the indexer core.
 *
 * THE CLOSURE GUARD IS THE POINT OF THIS FUNCTION. This job writes rows whose
 * `counterparty` is an ordinary payee, and it reads the same column to decide
 * scope. Left unguarded, run N's payees become run N+1's scan targets, then
 * theirs — a transitive closure over the Solana USDC payment graph, one hop per
 * run, reaching exchange hot wallets within a handful of ticks. That is the Arc
 * firehose arriving through a side door, and it is the same fixed-point shape
 * that made the counterparty backfill snapshot its seed rather than re-derive
 * it.
 *
 * THE GUARD IS AN EXCLUSION, NOT AN ALLOWLIST, and that distinction cost a
 * measurement to learn. The first version asked `facilitator IN
 * ALL_FACILITATOR_ADDRESSES` — "only x402 receipts nominate a provider" — which
 * sounds stricter and is in fact wrong: `SOLANA_FACILITATORS` is AUTO-GENERATED
 * from x402scan by `bun run sync:facilitators`, so an upstream reshuffle
 * silently shrinks scope, and rows written through a since-dropped facilitator
 * or the pay.sh path stop nominating their payees at all. Measured: the
 * allowlist produced a 351-wallet seed where the unfiltered derivation found
 * 1,217 payees.
 *
 * `USDC_MINT` is the one `facilitator` value THIS indexer ever writes, so
 * excluding it is exact and stable. If a fourth Solana ingest path ever adopts
 * its own sentinel, add that sentinel here — a one-line list, not a scope
 * regression on every upstream sync.
 */
export function buildSolanaSeedSet(input: SeedSetInput = {}): Set<string> {
  const exclusions = input.exclusions ?? SOLANA_TRANSFER_EXCLUSIONS;
  const seed = new Set<string>();

  for (const row of input.payeeRows ?? []) {
    // The closure guard: EXCLUDE what this job writes, never allow-list what
    // other jobs write. `facilitator` absent = the caller filtered server-side.
    if (row.facilitator === USDC_MINT) continue;

    const address = row.counterparty;
    if (!address) continue;
    if (!BASE58_ADDRESS.test(address)) continue;
    if (exclusions.has(address)) continue;
    seed.add(address);
  }

  return seed;
}

// ─── DI core ──────────────────────────────────────────────────────────────────

export interface SignatureRecord {
  signature: string;
  blockTime?: number | null;
}

export interface SolanaTransfersDeps {
  /** Everything in scope. Empty = the run is a no-op, never an unfiltered scan. */
  seed: ReadonlySet<string>;
  /** The wallets whose signature feed is walked. Usually [...seed]. */
  scanTargets: string[];
  getSignaturesForAddress: (
    address: string,
    opts: { limit: number; before?: string },
  ) => Promise<SignatureRecord[]>;
  parseTransactionsBatch: (signatures: string[]) => Promise<ParseBatchResult>;
  insertTransactions: (rows: Omit<Transaction, 'id'>[]) => Promise<number>;
  insertSignalEvents: (inputs: InsertSignalEventInput[]) => Promise<number>;
  ensureWallets: (addresses: string[]) => Promise<void>;
  /**
   * Queue the walked payer for rescoring. REQUIRED, not optional: the sibling
   * gap recovery shipped without it and moved zero scores off 2,222 recovered
   * rows (2fac4c9). Evidence no score reads is not recovered.
   */
  markDirty: (addresses: string[]) => Promise<void>;
  getCursor: (key: string) => Promise<{ last_signature: string; last_slot: number | null } | null>;
  upsertCursor: (key: string, lastSignature: string, lastSlot?: number) => Promise<void>;
  pageSize?: number;
  maxSignatures?: number;
  concurrency?: number;
  /** Wall-clock ceiling. Omit for unbounded (what the DI tests rely on). */
  timeBudgetMs?: number;
  /** Injected clock so the budget is testable without real waiting. */
  now?: () => number;
}

export interface SolanaTransfersRunResult extends IndexRunResult {
  /** Wallets whose walk errored. Their cursors did not move. */
  failed: string[];
  /** How many wallets were walked. Lets a caller detect an all-empty run. */
  scanned: number;
  /** Rejections by reason — the run's honesty record. */
  skipped: Record<string, number>;
  /** Signatures no endpoint served. NOT skipped history: retried next run. */
  unresolved: number;
  /** Accepted rows whose transaction carried more than one payee leg. */
  multiCredit: number;
}

/** Cursor key, namespaced so it can never collide with `wallet_scan:<address>`. */
export function solanaTransfersCursorKey(address: string): string {
  return `solana-transfers:${address}`;
}

interface WalletOutcome {
  address: string;
  status: 'ok' | 'failed';
  fetched: number;
  inserted: number;
  cursor?: string;
  skipped: Record<string, number>;
  unresolved: number;
  multiCredit: number;
}

/**
 * Walk one seeded provider's signature feed backwards and persist its payments.
 *
 * CURSOR DISCIPLINE, and it is the subtle part. The walk only ever moves
 * BACKWARDS, so a signature passed now is never revisited. The banked cursor is
 * therefore the deepest signature such that everything NEWER than it resolved —
 * we stop at the first unresolved signature and bank above it. An RPC miss then
 * costs one re-read next run instead of silently losing that slice of history,
 * which is the shape of both prior ingest-gap incidents.
 *
 * The cursor also advances only after this wallet's rows, signals and wallet row
 * are committed. A write failure banks nothing; the next run re-reads the page,
 * which is safe because every write is idempotent.
 */
async function walkWallet(
  deps: SolanaTransfersDeps,
  address: string,
  deadline: number,
  now: () => number,
  seenSignatures: Set<string>,
): Promise<WalletOutcome> {
  const pageSize = deps.pageSize ?? PAGE_SIZE;
  const maxSignatures = deps.maxSignatures ?? MAX_SIGNATURES;
  const cursorKey = solanaTransfersCursorKey(address);
  const empty = { skipped: {} as Record<string, number>, unresolved: 0, multiCredit: 0 };

  let before: string | undefined;
  try {
    const persisted = await deps.getCursor(cursorKey);
    if (persisted?.last_signature) before = persisted.last_signature;
  } catch (err) {
    console.error(`[solana-transfers] cursor read failed for ${address}:`, err);
    return { address, status: 'failed', fetched: 0, inserted: 0, ...empty };
  }

  const rows: Omit<Transaction, 'id'>[] = [];
  const signals: InsertSignalEventInput[] = [];
  const skipped: Record<string, number> = {};
  let unresolved = 0;
  let multiCredit = 0;
  let safeCursor: string | null = null;
  let scanned = 0;
  let blocked = false;

  while (scanned < maxSignatures && !blocked) {
    if (now() >= deadline) break;

    const limit = Math.min(pageSize, maxSignatures - scanned);
    let sigs: SignatureRecord[];
    try {
      sigs = await deps.getSignaturesForAddress(address, { limit, ...(before ? { before } : {}) });
    } catch (err) {
      console.error(`[solana-transfers] getSignaturesForAddress failed for ${address}:`, err);
      // Keep what earlier pages banked; this page is simply not walked.
      break;
    }
    if (sigs.length === 0) break;

    const signatures = sigs.map((s) => s.signature);
    let parsed: ParseBatchResult;
    try {
      parsed = await deps.parseTransactionsBatch(signatures);
    } catch (err) {
      console.error(`[solana-transfers] parseTransactionsBatch failed for ${address}:`, err);
      break;
    }

    const bySignature = new Map(parsed.transactions.map((t) => [t.signature, t]));
    const unresolvedSet = new Set(parsed.unresolved);

    // Newest-first. Advance the safe cursor only while signatures resolve; the
    // first unresolved one pins it and ends the walk for this wallet.
    for (const signature of signatures) {
      if (unresolvedSet.has(signature)) {
        // Report the whole page's misses, not just the one that blocked: all of
        // them are retry-eligible next run, and "unresolved: 1" would understate
        // how much history is still unread.
        unresolved += unresolvedSet.size;
        blocked = true;
        break;
      }
      scanned++;

      const tx = bySignature.get(signature);
      // Fetched but undecodable (no `meta`): final, not retry-eligible, so the
      // cursor is allowed past it.
      if (tx) {
        const decision = classifyUsdcDebit(tx, address, SOLANA_TRANSFER_EXCLUSIONS);
        if (decision.action === 'skip') {
          skipped[decision.reason] = (skipped[decision.reason] ?? 0) + 1;
        } else if (!seenSignatures.has(signature)) {
          seenSignatures.add(signature);
          if (decision.multiCredit) multiCredit++;
          rows.push(toTransactionRow(decision, address, tx));
          /**
           * SEEDED FACE ONLY — where this departs from arc-transfers.ts and
           * stellar-transfers.ts, deliberately.
           *
           * Those emit both faces and `ensureWallets` both sides. On Solana the
           * payee population is CEX deposit addresses and DEX vaults, and
           * `wallets` feeds `explore_agents` — the canonical agent count. A
           * provider-face Tier-1 receipt for an exchange's deposit address
           * would make it a Receipt-backed provider on the leaderboard.
           *
           * The FK on `transactions` covers `(chain, wallet_address)` only, so
           * minting the payee is a choice, not a requirement. We decline it.
           */
          signals.push(buildUsdcTransferSignal({
            walletAddress: address,
            face: 'consumer',
            chain: SOLANA_CHAIN,
            txHash: signature,
            amount: decision.amount,
            counterparty: decision.counterparty,
            observedAt: new Date(tx.timestamp * 1000).toISOString(),
          }));
        }
      }
      safeCursor = signature;
    }

    if (blocked) break;
    before = signatures[signatures.length - 1];
    if (sigs.length < limit) break; // history exhausted
  }

  if (safeCursor === null) {
    return { address, status: 'ok', fetched: 0, inserted: 0, skipped, unresolved, multiCredit };
  }

  let inserted = 0;
  try {
    if (rows.length > 0) {
      // FK: transactions references (chain, wallet_address) on wallets.
      // Insert-if-absent — never upsertWallet, which zeroed live scores on
      // 2026-08-02.
      await deps.ensureWallets([address]);
      inserted = await deps.insertTransactions(rows);
      await deps.insertSignalEvents(signals);
      // Inside the same try on purpose: rows this wallet gained that no score
      // ever reads are worse than re-walking the page (inserts are idempotent
      // on tx_signature), so a failure here must hold the cursor too.
      await deps.markDirty([address]);
    }
  } catch (err) {
    console.error(`[solana-transfers] write failed for ${address}:`, err);
    // Cursor NOT advanced — the next run re-reads this page.
    return { address, status: 'failed', fetched: 0, inserted: 0, skipped, unresolved, multiCredit };
  }

  try {
    await deps.upsertCursor(cursorKey, safeCursor);
  } catch (err) {
    console.error(`[solana-transfers] cursor write failed for ${address}:`, err);
    // Soft-fail: costs one re-read next run. Writes are idempotent.
  }

  return {
    address, status: 'ok', fetched: rows.length, inserted,
    cursor: safeCursor, skipped, unresolved, multiCredit,
  };
}

/**
 * Index outbound USDC payments for every scan target. Pure orchestration over
 * injected IO, mirroring stellarTransfersIndexer's shape.
 */
export async function solanaTransfersIndexer(
  deps: SolanaTransfersDeps,
): Promise<SolanaTransfersRunResult> {
  const cursors = new Map<string, string>();
  const skipped: Record<string, number> = {};

  /**
   * EMPTY SEED = NO-OP, BEFORE ANY IO. An empty seed means we know nothing
   * about this population; degrading to an unfiltered scan is the one failure
   * this design exists to prevent. No RPC calls, and no cursor moves — a cursor
   * advanced over blocks we never really examined is worse than no cursor.
   */
  if (deps.seed.size === 0 || deps.scanTargets.length === 0) {
    console.warn('[solana-transfers] seed set is empty — skipping run (no RPC calls, no cursor move)');
    return {
      fetched: 0, inserted: 0, cursors, failed: [],
      scanned: 0, skipped, unresolved: 0, multiCredit: 0,
    };
  }

  const now = deps.now ?? Date.now;
  const deadline = deps.timeBudgetMs != null ? now() + deps.timeBudgetMs : Number.POSITIVE_INFINITY;

  /**
   * Run-level, deliberately not per-wallet. `tx_signature` is UNIQUE, so at most
   * one row per transaction can land — and a payment A→B where BOTH are seeded
   * appears in both feeds. Deduplicating per wallet would emit two rows, the DB
   * would silently swallow one, and `fetched` would overstate what persisted.
   */
  const seenSignatures = new Set<string>();

  const outcomes = await withConcurrency(
    deps.scanTargets,
    deps.concurrency ?? ADDRESS_CONCURRENCY,
    (address) => walkWallet(deps, address, deadline, now, seenSignatures),
  );

  let fetched = 0;
  let inserted = 0;
  let unresolved = 0;
  let multiCredit = 0;
  const failed: string[] = [];

  for (const outcome of outcomes) {
    fetched += outcome.fetched;
    inserted += outcome.inserted;
    unresolved += outcome.unresolved;
    multiCredit += outcome.multiCredit;
    if (outcome.status === 'failed') failed.push(outcome.address);
    if (outcome.cursor) cursors.set(solanaTransfersCursorKey(outcome.address), outcome.cursor);
    for (const [reason, n] of Object.entries(outcome.skipped)) {
      skipped[reason] = (skipped[reason] ?? 0) + n;
    }
  }

  return {
    fetched, inserted, cursors, failed,
    scanned: deps.scanTargets.length, skipped, unresolved, multiCredit,
  };
}

// ─── Production wiring ────────────────────────────────────────────────────────

/** PostgREST page size for the seed read. */
const SEED_PAGE_SIZE = 1000;

/**
 * Seed scan cap. The 90-day window holds ~500k Solana rows, so this binds first:
 * the seed is "payees on the most recent ~420k x402 rows", reaching back roughly
 * two months. Measured 1,217 distinct payees at that depth with the discovery
 * curve already flattening (1,019 at 300k). Raise it to widen scope; the read
 * stays bounded either way, which is the point.
 */
export const SEED_SCAN_CAP = 420_000;

/**
 * THE one definition of "who is a Solana provider wallet", shared with
 * scripts/backfill-solana-counterparty.ts.
 *
 * Two jobs derive this same population, and the `facilitator IN (…)` filter is
 * the closure guard both of them need. Left as two copies, the copy that gets
 * the filter is the copy someone remembered — and the backfill script's copy
 * had no filter at all, so the moment this indexer wrote its first row a
 * `--reseed` there would have nominated CEX deposit addresses as providers and
 * queued their history for RPC fetches. One function, one guard, both callers.
 *
 * The filter runs SERVER-SIDE, so `buildSolanaSeedSet`'s own check is about
 * correctness while this one is about bandwidth. Neither stands in for the
 * other.
 */
export async function deriveSolanaProviderSeed(opts: {
  sinceDays?: number;
  scanCap?: number;
  onProgress?: (scanned: number, found: number) => void;
  /** Page size. Injected only by tests; production uses `SEED_PAGE_SIZE`. */
  pageSize?: number;
  /**
   * The page read, injected so the retry is testable without mocking the
   * module-global supabase client — `mock.module` is process-wide in bun, and
   * this suite shares one process with 97 other files.
   */
  readPage?: (offset: number, size: number, since: string) => Promise<SeedPageResult>;
} = {}): Promise<string[]> {
  const sinceDays = opts.sinceDays ?? 90;
  const scanCap = opts.scanCap ?? SEED_SCAN_CAP;
  const pageSize = opts.pageSize ?? SEED_PAGE_SIZE;
  const readPage = opts.readPage ?? readSeedPage;
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const seen = new Set<string>();

  for (let offset = 0; offset < scanCap; offset += pageSize) {
    // The throw MUST live inside the retried fn: supabase-js RETURNS `{ error }`
    // and never throws, so a `withTransientDbRetry` wrapped around the query
    // alone would retry nothing and quietly look correct.
    const rows = await withTransientDbRetry(async () => {
      const { data, error } = await readPage(offset, pageSize, since);
      if (error) throw error;
      return (data ?? []) as SeedPayeeRow[];
    });

    for (const address of buildSolanaSeedSet({ payeeRows: rows })) seen.add(address);
    if (rows.length < pageSize) break;
    if (offset > 0 && offset % 50_000 === 0) opts.onProgress?.(offset, seen.size);
  }

  return [...seen];
}

/** What one seed page read returns — supabase-js's shape, narrowed. */
export type SeedPageResult = {
  data: SeedPayeeRow[] | null;
  error: { code?: string; message?: string } | null;
};

/**
 * The live seed page. Split out from the loop so the retry has something to
 * retry and the test has something to replace.
 *
 * Measured 2026-09-11: a single `57014` at ~350k rows scanned killed a whole
 * derivation and the 14-hour run behind it. Page cost does grow with offset
 * (1.5s at 0, 4.1s at 400k) but stays far under the statement timeout, so the
 * cause is contention, not deep-offset exhaustion — which is why this is a
 * retry and not a switch to keyset pagination.
 */
async function readSeedPage(offset: number, size: number, since: string): Promise<SeedPageResult> {
  return supabase
    .from('transactions')
    // `facilitator` is selected so `buildSolanaSeedSet`'s closure guard is LIVE
    // rather than vacuous: without the column every row arrives with
    // `facilitator: undefined`, which the guard reads as "caller already
    // filtered". Belt and braces only works when both are actually fastened.
    .select('counterparty, facilitator')
    .eq('chain', SOLANA_CHAIN)
    .not('counterparty', 'is', null)
    // The closure guard, server-side: exclude only rows THIS indexer wrote.
    // Not `.in(ALL_FACILITATOR_ADDRESSES)` — see buildSolanaSeedSet's header
    // for why an allowlist off an auto-generated config shrinks scope.
    .neq('facilitator', USDC_MINT)
    .gte('timestamp', since)
    .order('timestamp', { ascending: false })
    .range(offset, offset + size - 1) as unknown as Promise<SeedPageResult>;
}

let _sigConn: Connection | null = null;
/**
 * Signature-feed reads go to the ARCHIVE endpoint, not `SOLANA_RPC_URL`.
 *
 * publicnode prunes its signature INDEX at ~2 days, so asking it for a
 * provider's history returns an empty feed — indistinguishable from "this
 * wallet never paid anyone", which is precisely the wrong answer for this job.
 * `getArchiveRpcUrl()` is the same resolution `parseTransactionsBatch` already
 * uses for its fallback, so both halves of a walk read the same horizon.
 * Memoized: one `Connection` per process, not one per page.
 */
function signatureConnection(): Connection {
  if (!_sigConn) _sigConn = new Connection(getArchiveRpcUrl(), 'confirmed');
  return _sigConn;
}

export interface RunSolanaTransfersOptions {
  /** Restrict the walk to these addresses. Must be a subset of the seed. */
  only?: readonly string[];
  maxSignatures?: number;
  concurrency?: number;
  timeBudgetMs?: number;
  /** Swap in counting no-ops for a dry run. */
  overrides?: Partial<SolanaTransfersDeps>;
}

/**
 * Production run. MANUAL AND UNSCHEDULED, matching how arc-transfers and
 * stellar-transfers were left after their dry runs. Wiring this into the Solana
 * adapter or the ingest floor is a separate, evidence-backed decision — and it
 * requires re-scoping `/api/cron/indexer`'s freshness probe first, which reads
 * `max(timestamp)` across all facilitators and would otherwise stay green on
 * these rows while x402 ingest was dead.
 */
export async function runSolanaTransfersIndexer(
  opts: RunSolanaTransfersOptions = {},
): Promise<SolanaTransfersRunResult> {
  const seedList = opts.only ? [...opts.only] : await deriveSolanaProviderSeed();
  const seed = new Set(seedList);

  return solanaTransfersIndexer({
    seed,
    scanTargets: seedList,
    getSignaturesForAddress: async (address, pageOpts) => {
      // Every sibling indexer wraps its RPC in this; mainnet-beta throttles a
      // sequential walk, and a 429 THROWS, which costs the wallet its page.
      const sigs = await withRateLimitRetry(
        () => signatureConnection().getSignaturesForAddress(new PublicKey(address), pageOpts),
        INGEST_RETRY,
      );
      return sigs.map((s) => ({ signature: s.signature, blockTime: s.blockTime ?? null }));
    },
    parseTransactionsBatch: defaultParseTransactionsBatch,
    insertTransactions: dbInsertTransactions,
    insertSignalEvents: dbInsertSignalEvents,
    ensureWallets: dbMakeEnsureWallets(SOLANA_CHAIN),
    markDirty: dbMarkWalletsDirty,
    getCursor: async (key) =>
      withTransientDbRetry(async () => {
        const cursor = await dbGetCursor(key);
        return cursor
          ? { last_signature: cursor.last_signature, last_slot: cursor.last_slot ?? null }
          : null;
      }),
    upsertCursor: async (key, sig, slot) =>
      withTransientDbRetry(async () => { await dbUpsertCursor(key, sig, slot ?? undefined); }),
    timeBudgetMs: opts.timeBudgetMs ?? SOLANA_RUN_TIME_BUDGET_MS,
    ...(opts.maxSignatures != null ? { maxSignatures: opts.maxSignatures } : {}),
    ...(opts.concurrency != null ? { concurrency: opts.concurrency } : {}),
    ...opts.overrides,
  });
}
