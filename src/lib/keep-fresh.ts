/**
 * keep-fresh orchestration — the step sequence, independent of how it is run.
 *
 * Split out of `src/scripts/keep-fresh.ts` (which stays the thin CLI) for the
 * same reason `runIndexer` lives apart from `indexer/run.ts`: the interesting
 * behaviour here is *what survives what*, and that is only testable when the
 * steps are injected.
 *
 * Two invariants this file exists to hold.
 *
 * **A failed step degrades to a failed step, never to an ended run.** The floor
 * is defense-in-depth for every chain at once, so the Solana indexer crashing
 * must not take the scoring drain and the freshness verdict down with it —
 * which is exactly what a straight-line `main()` did on 2026-08-17.
 *
 * **The run pages on whether it could do its job, not on what it classified.**
 * Between 2026-09-11 and 09-19, 25 of 35 scheduled runs paged; 24 of those
 * logged `freshness: fresh` and 19 had ingested receipts and scored every
 * wallet in the same run. Meanwhile one run that did NO work — the lease was
 * held elsewhere, nothing was indexed, data was 5 h old — exited 0 in silence.
 * Noisy and blind were the same defect: the exit code tracked internal step
 * accounting. Accounting (`unresolved`, retained gaps, `catching_up`, a
 * throttle that still read targets) is DISCLOSURE and belongs on the health
 * surface, which already publishes it at `/api/v2/indexing/status`. The page is
 * for "a human must act now".
 */

import type { WatchdogTick } from './helius-watchdog';
import type { RescoreResult } from '@/scripts/rescore-dirty';
import { assessIngestFreshness, type FreshnessReport } from './ingest-health';

export interface IndexerSummary {
  fetched: number;
  inserted: number;
  /**
   * Wallets handed to the deferred-scoring queue because a receipt landed for
   * them. Named `queued`, not `scored`: the indexer no longer scores inline,
   * and reporting enqueued work as completed work is how a regression hides.
   */
  queued: number;
  payshSignals: number;
  operatorsScored: number;
  /**
   * Signatures no RPC could serve this run. Disclosed, never paged: the cursor
   * is held so the next run retries, and every observed instance was a single
   * signature its archive endpoint rate-limited once — verified present on
   * chain the next day. Paging on it produced 13 alerts in four days and never
   * named an action. See `lib/indexing-exit.ts`, which already says the same
   * about the identical counter one layer down.
   */
  unresolved: number;
}

/** What the managed indexing task made of the run, plus whether it finished. */
export interface IndexerStepResult {
  /** The run's own counts. Absent when the scan never got far enough to report. */
  summary: IndexerSummary | null;
  status: string;
  errorCode?: string;
  stalled?: boolean;
  /**
   * True iff `runIndexer` RETURNED. False means it threw, was aborted at its
   * lease deadline, or never started. This is the load-bearing distinction:
   * counters do not survive a failure (the runner builds its failure outcome
   * with no counts at all, so `checkedCount` is `undefined`, not `0`), but
   * "did the call return" always does.
   */
  completed: boolean;
}

export interface KeepFreshDeps {
  /** Re-enable + auth-sync the Helius webhook. Null when no Helius key is set. */
  syncWebhook: () => Promise<WatchdogTick | null>;
  /** Poll Solana facilitators and ingest new txs. */
  index: () => Promise<IndexerStepResult>;
  /** Arc historical path. Retired to a stub on main; kept injected so a failure
   *  here still cannot cancel the Solana steps (the 2026-08-17 shape). */
  indexArc: () => Promise<{ fetched: number; inserted: number }>;
  /** One bounded batch of the deferred-scoring backlog. */
  drainOnce: () => Promise<RescoreResult>;
  /** Timestamp (ISO) of the newest indexed transaction, for the verdict. */
  readLastTxIso: () => Promise<string | null>;
  /**
   * When the Solana payments path last FINISHED a scan, by any owner.
   *
   * Only consulted when this run found the lease busy. "Busy" alone is not a
   * fault — the hourly in-app worker legitimately holds it — so the question
   * that matters is whether anybody completed a scan recently, not whether this
   * particular process got to run.
   */
  readIndexerLastFinishedIso: () => Promise<string | null>;
  now?: () => number;
}

export interface KeepFreshOptions {
  /** Upper bound on drain batches; the loop exits early once the queue empties. */
  drainBatches?: number;
}

export interface KeepFreshOutcome {
  /** Step names that threw, in run order. Empty is the healthy case. */
  failedSteps: string[];
  /** Webhook sync is redundancy, so its failure is reported but never fatal. */
  webhookError: string | null;
  indexer: IndexerSummary | null;
  arc: { fetched: number; inserted: number } | null;
  /** Non-null when the indexer reported something short of a clean, complete scan. */
  indexerDegraded: string | null;
  drained: number;
  drainBatchesRun: number;
  drainErrors: number;
  /** No endpoint could serve 8004 reads, so scored wallets were left queued. */
  attestationsUnavailable: boolean;
  freshness: FreshnessReport | null;
  /** Why this run pages, in priority order. Empty ⇒ ok. */
  pageReasons: string[];
  /** False → the caller must exit non-zero so CI pages. */
  ok: boolean;
}

const DEFAULT_DRAIN_BATCHES = 50;
/**
 * How long "nobody finished a scan" has to hold before a busy lease is a fault.
 * Matched to the freshness warning threshold: the two questions ("is the data
 * ageing", "is anyone collecting it") should not disagree about what recent is.
 */
const STALE_SCAN_MS = 2 * 60 * 60 * 1000;

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

export async function runKeepFresh(
  deps: KeepFreshDeps,
  opts: KeepFreshOptions = {},
): Promise<KeepFreshOutcome> {
  const now = deps.now ?? Date.now;
  const maxDrainBatches = opts.drainBatches ?? DEFAULT_DRAIN_BATCHES;
  const failedSteps: string[] = [];
  const pageReasons: string[] = [];

  /** Run a step; on failure record it and carry on to the next one. */
  async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      failedSteps.push(name);
      console.error(`[keep-fresh] ${name} step failed:`, message(err));
      return null;
    }
  }

  // 1. Webhook — restores the real-time fast path. Redundancy on top of the
  //    poller below, so its failure is logged, not counted.
  let webhookError: string | null = null;
  try {
    const tick = await deps.syncWebhook();
    if (!tick) {
      console.log('[keep-fresh] webhook: skipped (no Helius key)');
    } else {
      console.log(
        `[keep-fresh] webhook: matched=${tick.matched} active=${tick.active} ` +
        `reEnabled=${tick.reEnabled.length} errors=${tick.errors.length}`,
      );
      for (const e of tick.errors) console.error(`[keep-fresh] webhook error: ${e}`);
    }
  } catch (err) {
    webhookError = message(err);
    console.error('[keep-fresh] webhook step failed:', webhookError);
  }

  // 2. Solana indexer — the webhook-independent ingest floor.
  const step2 = await step('indexer', deps.index);
  const indexer = step2?.summary ?? null;
  let indexerDegraded: string | null = null;

  if (indexer) {
    console.log(
      `[keep-fresh] indexer: fetched=${indexer.fetched} inserted=${indexer.inserted} ` +
      `queued=${indexer.queued} payshSignals=${indexer.payshSignals} ` +
      `operatorsScored=${indexer.operatorsScored} unresolved=${indexer.unresolved}`,
    );
  }

  if (step2) {
    if (step2.status === 'lease_lost') {
      // Another owner took the lease mid-run, so whatever this run wrote raced
      // a writer it cannot see. The result is not trustworthy, unlike a scan
      // that merely reported partial coverage.
      pageReasons.push('indexer lease_lost');
    } else if (step2.status === 'busy') {
      // Deferring to a live worker is the design, not a fault — unless nobody
      // has actually finished a scan. That case (2026-09-15) exits 0 today.
      const lastFinished = await step('indexer-liveness', deps.readIndexerLastFinishedIso);
      const finishedMs = lastFinished ? Date.parse(lastFinished) : NaN;
      const stale = !Number.isFinite(finishedMs) || now() - finishedMs > STALE_SCAN_MS;
      if (stale) {
        pageReasons.push(
          `indexer lease busy and no scan finished since ${lastFinished ?? 'ever'}`,
        );
      } else {
        indexerDegraded = 'busy';
        console.log(`[keep-fresh] indexer: skipped — lease held, last scan finished ${lastFinished}`);
      }
    } else if (!step2.completed) {
      // Threw, or aborted at the lease deadline. Either way the scan did not
      // run to the end, and nothing downstream can assume it did.
      pageReasons.push(`indexer did not complete (${step2.errorCode ?? step2.status})`);
    } else if (step2.status === 'failed') {
      // A scan can RETURN and still have observed nothing: `coverageOutcome`
      // reports `failed` for a throttle that checked zero targets, and for
      // `all_absent` / `rpc_unavailable` / `address_failure`. Completing is not
      // the same as succeeding, so this is a page even though the call returned.
      pageReasons.push(`indexer scan failed (${step2.errorCode ?? 'unknown'})`);
    } else if (step2.stalled) {
      pageReasons.push('indexer stalled');
    } else if (step2.status !== 'caught_up' || (indexer?.unresolved ?? 0) > 0) {
      // Disclosed, not paged: the scan ran and is reporting known debt.
      indexerDegraded = step2.errorCode ?? step2.status;
      console.warn(
        `[keep-fresh] DEGRADED: ${indexerDegraded}` +
        ((indexer?.unresolved ?? 0) > 0
          ? ` · ${indexer?.unresolved} unserved signature(s), cursors held`
          : '') +
        ' — disclosed on /api/v2/indexing/status, not paged',
      );
    }
  }

  // 2b. Arc — retired stub on main. Still run as its own isolated step so a
  //     future re-enable cannot be cancelled by a crashed Solana indexer.
  const arc = await step('arc', deps.indexArc);
  if (arc && arc.inserted > 0) {
    console.log(`[keep-fresh] arc: fetched=${arc.fetched} inserted=${arc.inserted}`);
  }

  // 3. Drain the deferred-scoring backlog (bounded). With the indexer queueing
  //    rather than scoring inline, this is where Solana scores are now written.
  let drained = 0;
  let drainBatchesRun = 0;
  let drainErrors = 0;
  let attestationsUnavailable = false;
  let drainRemaining = 0;
  await step('drain', async () => {
    for (let i = 0; i < maxDrainBatches; i++) {
      const r = await deps.drainOnce();
      drained += r.scored;
      drainErrors += r.errors.length;
      drainRemaining = r.remaining;
      if (r.attestationsUnavailable) attestationsUnavailable = true;
      drainBatchesRun++;
      if (r.claimed > 0 || r.errors.length > 0) {
        console.log(
          `[keep-fresh] drain ${i + 1}/${maxDrainBatches}: claimed=${r.claimed} ` +
          `scored=${r.scored} remaining=${r.remaining} errors=${r.errors.length}`,
        );
      }
      if (r.claimed === 0 || r.remaining === 0) break;
    }
  });
  console.log(
    `[keep-fresh] drain: scored=${drained} over ${drainBatchesRun} batch(es)` +
    ` · remaining=${drainRemaining} errors=${drainErrors}` +
    (attestationsUnavailable ? ' · attestation endpoints unavailable' : ''),
  );
  // A backlog that claims work and completes none is stuck. `drainOnce` collects
  // per-wallet failures instead of throwing, so without this the scoring half of
  // the floor could fail on every wallet, every run, forever, and never page.
  if (drainErrors > 0 && drained === 0) {
    pageReasons.push(`drain claimed work and scored none (${drainErrors} error(s))`);
  }

  // 4. Freshness verdict.
  const lastTxIso = await step('freshness', deps.readLastTxIso);
  const freshness = lastTxIso === null && failedSteps.includes('freshness')
    ? null
    : assessIngestFreshness(lastTxIso, now());
  if (freshness) {
    const ageH = freshness.ageMs != null ? `${Math.round(freshness.ageMs / 3_600_000)}h` : 'n/a';
    console.log(
      `[keep-fresh] freshness: ${freshness.severity} · last tx ${freshness.lastTxAt ?? 'none'} (age ${ageH})`,
    );
  }

  if (!freshness) {
    pageReasons.push('freshness unreadable');
  } else if (freshness.severity === 'critical') {
    pageReasons.push('ingest critically stale');
  } else if (freshness.severity === 'unknown') {
    // A read that succeeded and found no row. Silent today, because only
    // 'critical' was ever checked.
    pageReasons.push('no indexed transactions at all');
  }

  // A step that THREW is an infrastructure fault (missing env, unreachable DB,
  // an unexpected exception) — never a classification. Those always page.
  if (failedSteps.length > 0) {
    pageReasons.unshift(`step(s) threw: ${failedSteps.join(', ')}`);
  }

  return {
    failedSteps,
    webhookError,
    indexer,
    arc,
    indexerDegraded,
    drained,
    drainBatchesRun,
    drainErrors,
    attestationsUnavailable,
    freshness,
    pageReasons,
    ok: pageReasons.length === 0,
  };
}
