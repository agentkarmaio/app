/**
 * Facilitator gap recovery.
 *
 * Sixteen facilitators sit behind a cursor their indexer RPC can no longer
 * resolve; five of them have real un-ingested history behind it. Recovering it
 * means walking from the address's tip back down to the stored cursor on a
 * FULL-HISTORY endpoint — which `getSignaturesForAddress` cannot do in one call
 * (1000 signatures max), and which `keep-fresh:backfill` cannot do at all (its
 * RPC retains ~2 days; the gaps are 59-81 days old).
 *
 * Spec: (design notes, kept out of this repo)
 */

import type { Transaction } from '../db/schema';
import type { HeliusEnhancedTransaction, ParseBatchResult } from './helius';

export interface SignatureRecord {
  signature: string;
  blockTime?: number | null;
}

export type FetchSignatures = (
  opts: { limit: number; until?: string; before?: string },
) => Promise<SignatureRecord[]>;

const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_SIGNATURES = 10_000;

/**
 * Walk an address's signatures from the tip down to `cursor`, paging with
 * `before`. Returns newest-first, exactly as the RPC orders them.
 */
export async function pageSignaturesUntil(
  fetchSignatures: FetchSignatures,
  opts: { cursor?: string; pageSize?: number; maxSignatures?: number } = {},
): Promise<{ signatures: SignatureRecord[]; capped: boolean; pages: number }> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxSignatures = opts.maxSignatures ?? DEFAULT_MAX_SIGNATURES;

  const signatures: SignatureRecord[] = [];
  let before: string | undefined;
  let pages = 0;
  let capped = false;

  for (;;) {
    if (signatures.length >= maxSignatures) { capped = true; break; }

    const fetchOpts: { limit: number; until?: string; before?: string } = { limit: pageSize };
    // `until` goes on EVERY page. It is what makes the RPC stop at the gap's
    // floor; sending it only on the first call lets page 2 walk the address's
    // entire history, unbounded except by maxSignatures.
    if (opts.cursor) fetchOpts.until = opts.cursor;
    if (before) fetchOpts.before = before;

    const page = await fetchSignatures(fetchOpts);
    pages++;
    if (page.length === 0) break;              // reached the cursor

    signatures.push(...page);
    before = page[page.length - 1].signature;

    if (page.length < pageSize) break;         // history exhausted
  }

  if (signatures.length > maxSignatures) signatures.length = maxSignatures;

  return { signatures, capped, pages };
}

// ─── Recovery run ────────────────────────────────────────────────────────────

export interface GapRecoveryDeps {
  fetchSignatures: FetchSignatures;
  parseBatch: (sigs: string[]) => Promise<ParseBatchResult>;
  extract: (tx: HeliusEnhancedTransaction, facilitator: string) => Omit<Transaction, 'id'> | null;
  /** Committed per batch, so a killed run keeps the progress it made. */
  persist: (rows: Omit<Transaction, 'id'>[]) => Promise<number>;
  /** Advance the cursor. Called ONLY on a complete, fully-resolved recovery. */
  advanceCursor?: (address: string, signature: string) => Promise<void>;
}

export interface GapRecoveryResult {
  address: string;
  /** Signatures found between the tip and the stored cursor. */
  gap: number;
  /** True when `maxSignatures` stopped the walk before the cursor was reached. */
  capped: boolean;
  scanned: number;
  extracted: number;
  inserted: number;
  /** Signatures no RPC could serve — the gap is NOT closed while this is > 0. */
  unresolved: number;
  cursorAdvanced: boolean;
  /** True only when the whole gap was walked AND every signature resolved. */
  complete: boolean;
}

/** Parse batch size. Kept small: the archive endpoint rate-limits hard, and the
 *  cursor advances once per batch, so smaller batches lose less to a kill. */
const RECOVERY_BATCH = 25;

/**
 * Recover one facilitator's un-ingested history.
 *
 * Writes per batch rather than accumulating — `runIndexer(backfill)` fetches
 * every address before its first write, so a run killed part-way commits
 * nothing, which is why a long gap has never actually been closed by it.
 *
 * The cursor advances only on a clean, complete pass. A dead cursor is the ONLY
 * record of where a gap begins: burning it on a partial run makes the remainder
 * unreachable and unmeasurable.
 */
export async function recoverFacilitatorGap(
  address: string,
  cursor: string | undefined,
  deps: GapRecoveryDeps,
  opts: { pageSize?: number; maxSignatures?: number; dryRun?: boolean; batchSize?: number } = {},
): Promise<GapRecoveryResult> {
  const { signatures, capped } = await pageSignaturesUntil(deps.fetchSignatures, {
    cursor,
    pageSize: opts.pageSize,
    maxSignatures: opts.maxSignatures,
  });

  const result: GapRecoveryResult = {
    address, gap: signatures.length, capped,
    scanned: 0, extracted: 0, inserted: 0, unresolved: 0,
    cursorAdvanced: false, complete: false,
  };
  if (signatures.length === 0 || opts.dryRun) return result;

  // Oldest-first: a run killed half-way then leaves a CONTIGUOUS remainder at
  // the top, which the same cursor still anchors. Newest-first would leave a
  // hole in the middle that nothing records.
  const ordered = [...signatures].reverse().map((s) => s.signature);

  // The cursor climbs behind the contiguous, fully-resolved prefix, one batch at
  // a time — 14,019 signatures against a rate-limited endpoint will outlive a CI
  // job's timeout, and a kill must not cost the whole walk.
  //
  // A CAPPED walk never advances: capping stops before reaching the cursor, so
  // the signatures in hand are the TOP of the gap, not adjacent to it. Moving
  // the cursor up would skip the hole underneath them — the original bug, in a
  // new place.
  const batchSize = opts.batchSize ?? RECOVERY_BATCH;
  let prefixIntact = !capped;

  for (let i = 0; i < ordered.length; i += batchSize) {
    const batch = ordered.slice(i, i + batchSize);
    const parsed = await deps.parseBatch(batch);
    result.scanned += batch.length;
    result.unresolved += parsed.unresolved.length;

    const rows: Omit<Transaction, 'id'>[] = [];
    for (const tx of parsed.transactions) {
      const payment = deps.extract(tx, address);
      if (payment) rows.push(payment);
    }
    result.extracted += rows.length;
    if (rows.length > 0) result.inserted += await deps.persist(rows);

    // One unresolved signature ends the prefix: everything above it is no longer
    // contiguous with the cursor.
    if (parsed.unresolved.length > 0) prefixIntact = false;
    if (!prefixIntact || !deps.advanceCursor) continue;

    // `ordered` is oldest-first, so the batch's last entry is its newest.
    await deps.advanceCursor(address, batch[batch.length - 1]);
    result.cursorAdvanced = true;
  }

  result.complete = !capped && result.unresolved === 0;
  return result;
}
