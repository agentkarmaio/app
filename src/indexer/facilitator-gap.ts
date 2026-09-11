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
  /**
   * Queue the recovered payers for rescoring. Without this the receipts land and
   * no karma moves — which is what the first live run did: 2,222 rows ingested,
   * zero scores changed. Same wiring wallet-scan already has.
   */
  markDirty?: (addresses: string[]) => Promise<void>;
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
  /**
   * Set when the walk aborted part-way. The run is NOT thrown away: rows
   * committed before the abort are counted above and the cursor still moves up
   * behind them. Run 34611182319 lost 83 minutes of cursor progress and
   * reported "inserted 0" for 2,241 committed rows because this threw instead.
   */
  error?: string;
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
  let lastAdvanced: string | null = null;
  const missed: string[] = [];

  /** Decode a batch, extract, persist. Returns what no endpoint could serve. */
  const ingest = async (batch: string[]): Promise<string[]> => {
    const parsed = await deps.parseBatch(batch);
    const rows: Omit<Transaction, 'id'>[] = [];
    for (const tx of parsed.transactions) {
      const payment = deps.extract(tx, address);
      if (payment) rows.push(payment);
    }
    result.extracted += rows.length;
    if (rows.length > 0) {
      result.inserted += await deps.persist(rows);
      // Per batch, like the insert: a killed run leaves the payers it already
      // recovered queued for scoring rather than silently inert.
      const payers = [...new Set(rows.map((r) => r.wallet_address).filter(Boolean))];
      if (payers.length > 0 && deps.markDirty) await deps.markDirty(payers);
    }
    return parsed.unresolved;
  };

  // How many signatures were actually attempted. On an abort this is less than
  // ordered.length, and the prefix recompute below MUST be bounded by it —
  // unbounded, it would see no holes among the processed batches and jump the
  // cursor to the top of the gap, skipping everything never walked.
  let processed = 0;

  try {
    for (let i = 0; i < ordered.length; i += batchSize) {
      const batch = ordered.slice(i, i + batchSize);
      const unresolved = await ingest(batch);
      result.scanned += batch.length;
      processed += batch.length;
      missed.push(...unresolved);

      // One unresolved signature ends the prefix: everything above it is no
      // longer contiguous with the cursor.
      if (unresolved.length > 0) prefixIntact = false;
      if (!prefixIntact || !deps.advanceCursor) continue;

      // `ordered` is oldest-first, so the batch's last entry is its newest.
      lastAdvanced = batch[batch.length - 1];
      await deps.advanceCursor(address, lastAdvanced);
      result.cursorAdvanced = true;
    }
  } catch (err) {
    // Transport drops happen on an 80-minute walk. Record and fall through:
    // the rows are already committed, and the cursor still deserves to move up
    // behind them.
    result.error = err instanceof Error ? err.message : String(err);
  }

  // Second pass over the misses. Measured on the first real run: 10 transient
  // archive 429s in 2,656 signatures, the first in batch 3 of ~107 — enough to
  // freeze the cursor for the remaining ~2,600 and force the whole walk to be
  // redone. Retrying costs one extra call per miss and is what lets a flaky
  // endpoint still produce a complete run.
  // Skipped after an abort: the retry needs the network that just failed, and
  // treating an un-retried miss as permanent only makes the cursor advance
  // LESS, which is the safe direction.
  let stillMissing = missed;
  if (missed.length > 0 && !capped && !result.error) {
    const remaining: string[] = [];
    for (let i = 0; i < missed.length; i += batchSize) {
      remaining.push(...(await ingest(missed.slice(i, i + batchSize))));
    }
    stillMissing = remaining;
  }
  result.unresolved = stillMissing.length;
  result.complete =
    !capped && result.unresolved === 0 && !result.error && processed === ordered.length;

  // Recompute the prefix against what is missing AFTER the retries, not during
  // the walk. Measured 2026-09-11: retries cleared 115 misses down to 4, yet the
  // cursor had stopped at the first of the 115 — crediting 650 of 2,606
  // signatures when nearly all of them had, in the end, resolved.
  //
  // Signature granularity, not batch: the prefix ends immediately below the
  // OLDEST signature still missing. A capped walk is still excluded entirely —
  // its signatures are not adjacent to the cursor at all.
  if (!capped && deps.advanceCursor) {
    const holes = new Set(stillMissing);
    const walked = ordered.slice(0, processed);
    let prefixEnd = walked.length - 1;
    for (let i = 0; i < walked.length; i++) {
      if (holes.has(walked[i])) { prefixEnd = i - 1; break; }
    }
    const target = prefixEnd >= 0 ? ordered[prefixEnd] : null;
    if (target && target !== lastAdvanced) {
      await deps.advanceCursor(address, target);
      result.cursorAdvanced = true;
    }
  }
  return result;
}
