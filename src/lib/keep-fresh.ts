/**
 * keep-fresh orchestration — the step sequence, independent of how it is run.
 *
 * Split out of `src/scripts/keep-fresh.ts` (which stays the thin CLI) for the
 * same reason `runIndexer` lives apart from `indexer/run.ts`: the interesting
 * behaviour here is *what survives what*, and that is only testable when the
 * steps are injected.
 *
 * The invariant this file exists to hold: **a failed step degrades to a failed
 * step, never to an ended run.** The floor is defense-in-depth for every chain
 * at once, so the Solana indexer crashing must not take Arc ingest, the scoring
 * drain and the freshness verdict down with it — which is exactly what a
 * straight-line `main()` did on 2026-08-17 (6 of 30 runs, all DB `57014`, each
 * one silently costing Arc a whole 6h cycle).
 *
 * Failure is still failure: any failed step, or critical staleness, makes the
 * run non-ok so the caller exits 1 and the `if: failure()` Telegram page fires.
 * The difference is that the page can now name the step.
 */

import type { WatchdogTick } from './helius-watchdog';
import type { RescoreResult } from '@/scripts/rescore-dirty';
import { assessIngestFreshness, type FreshnessReport } from './ingest-health';

export interface IndexerSummary {
  fetched: number;
  inserted: number;
  scored: number;
  payshSignals: number;
  operatorsScored: number;
}

export interface KeepFreshDeps {
  /** Re-enable + auth-sync the Helius webhook. Null when no Helius key is set. */
  syncWebhook: () => Promise<WatchdogTick | null>;
  /** Poll Solana facilitators and ingest new txs. */
  index: () => Promise<IndexerSummary>;
  /** Arc job-escrow settlements + plain USDC transfers. */
  indexArc: () => Promise<{ fetched: number; inserted: number }>;
  /** One bounded batch of the deferred-scoring backlog. */
  drainOnce: () => Promise<RescoreResult>;
  /** Timestamp (ISO) of the newest indexed transaction, for the verdict. */
  readLastTxIso: () => Promise<string | null>;
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
  drained: number;
  drainBatchesRun: number;
  freshness: FreshnessReport | null;
  /** False → the caller must exit non-zero so CI pages. */
  ok: boolean;
}

const DEFAULT_DRAIN_BATCHES = 50;

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
  const indexer = await step('indexer', deps.index);
  if (indexer) {
    console.log(
      `[keep-fresh] indexer: fetched=${indexer.fetched} inserted=${indexer.inserted} ` +
      `scored=${indexer.scored} payshSignals=${indexer.payshSignals} ` +
      `operatorsScored=${indexer.operatorsScored}`,
    );
  }

  // 2b. Arc — job-escrow settlements + plain USDC transfers. Runs regardless of
  //     step 2's outcome: the chains share nothing but this script, and Arc's
  //     only ingest path is this step (no webhook, no second cron).
  const arc = await step('arc', deps.indexArc);
  if (arc && arc.inserted > 0) {
    console.log(`[keep-fresh] arc: fetched=${arc.fetched} inserted=${arc.inserted}`);
  }

  // 3. Drain the deferred-scoring backlog (bounded). Steady-state this clears in
  //    one batch; the first recovery run chews through the accumulated backlog.
  let drained = 0;
  let drainBatchesRun = 0;
  await step('drain', async () => {
    for (let i = 0; i < maxDrainBatches; i++) {
      const r = await deps.drainOnce();
      drained += r.scored;
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
  console.log(`[keep-fresh] drain: scored=${drained} over ${drainBatchesRun} batch(es)`);

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

  return {
    failedSteps,
    webhookError,
    indexer,
    arc,
    drained,
    drainBatchesRun,
    freshness,
    ok: failedSteps.length === 0 && freshness?.severity !== 'critical',
  };
}
