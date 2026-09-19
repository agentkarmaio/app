/**
 * keep-fresh — CLI for the freshness floor, runnable fully OUT OF PROCESS
 * (e.g. GitHub Actions). This is the resilient layer of defense-in-depth: it
 * survives even when the web app or its in-process workers are wedged, which is
 * exactly how the 2026-05-21 → 06-06 outage went unnoticed (webhook
 * auto-disabled, in-process watchdog never re-enabled it, servel cron is
 * non-functional on this cluster).
 *
 * This file only parses flags, wires the real implementations in, and turns the
 * outcome into an exit code. The step sequence — and the rule that decides what
 * is worth waking someone for — lives in `src/lib/keep-fresh.ts`, where it is
 * testable (mirrors indexer/run.ts → indexer/index.ts).
 *
 * Steps (each reuses existing logic — no duplicated ingest/scoring code):
 *   1. Re-enable + auth-sync the Helius webhook            (checkOnce)
 *   2. Poll facilitators and ingest new txs                (runIndexer)
 *   2b. Arc — retired stub, still isolated as its own step
 *   3. Drain the deferred-scoring backlog, bounded         (drainOnce)
 *   4. Report post-run ingest freshness                    (assessIngestFreshness)
 *
 * Exits 1 only when the floor could not do its job — see `runKeepFresh`. The
 * classification a scan reports (unserved signatures, retained gaps,
 * `catching_up`) is disclosure, published on /api/v2/indexing/status, and does
 * NOT page: keying the exit code on it produced 25 pages in nine days, 24 of
 * them while ingest was current.
 *
 * Usage:
 *   bun run src/scripts/keep-fresh.ts [--backfill] [--limit N]
 *                                     [--drain-batches N] [--drain-limit N]
 *
 * Env (provide as CI secrets when run externally):
 *   HELIUS_RPC_URL or HELIUS_API_KEY      — RPC + webhook API
 *   HELIUS_WEBHOOK_SECRET                 — must match the server's, so the
 *                                           re-enabled webhook's authHeader is
 *                                           accepted by /api/webhook/helius
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — DB writes
 *   KEEP_FRESH_SUMMARY_FILE               — optional; one-line verdict is
 *                                           written here for the CI alert step
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { checkOnce } from '../lib/helius-watchdog';
import { runIndexer } from '../indexer/index';
import { drainOnce } from './rescore-dirty';
import {
  createIndexingJob,
  runManagedIndexingTask,
  readLatestSolanaTransaction,
  coverageOutcome,
} from '../lib/indexing-jobs';
import { readIndexingStates } from '../db/indexing-state';
import { runKeepFresh, type IndexerStepResult, type KeepFreshOutcome } from '../lib/keep-fresh';
import { requireEnv } from '../lib/require-env';


// DB writes are mandatory; without them the floor cannot ingest. Fail at line 1
// with a clear message (the 2026-06-23 outage: secrets unset → cryptic crash 8
// frames deep, no alert). Helius is optional — the indexer falls back to the
// free SOLANA_RPC_URL / public RPC, and the webhook step self-skips without a key.
const REQUIRED_ENV = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

function numArg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const backfill = process.argv.includes('--backfill');
const limit = numArg('--limit', backfill ? 1000 : 200);
const drainBatches = numArg('--drain-batches', 50);
const drainLimit = numArg('--drain-limit', 500);

/**
 * One line carrying status, cause and counts.
 *
 * The page used to say only "one or more floor steps failed — open the log",
 * because the CLI threw a bare `'solana_scan_failed'` and discarded the status,
 * the error code and every count. Diagnosing the 2026-09-19 page needed
 * timestamp arithmetic across 1,600 log lines; a phone notification cannot do
 * that. Whatever this line says is what the Telegram alert says.
 */
function verdictLine(outcome: KeepFreshOutcome): string {
  const ix = outcome.indexer;
  const f = outcome.freshness;
  return [
    `[keep-fresh] verdict=${outcome.ok ? 'ok' : 'PAGE'}`,
    outcome.pageReasons.length > 0 ? `why="${outcome.pageReasons.join('; ')}"` : '',
    outcome.indexerDegraded ? `degraded=${outcome.indexerDegraded}` : '',
    ix ? `fetched=${ix.fetched} inserted=${ix.inserted} queued=${ix.queued} unresolved=${ix.unresolved}` : 'indexer=no-summary',
    `drained=${outcome.drained} drainErrors=${outcome.drainErrors}`,
    outcome.attestationsUnavailable ? 'attestations=unavailable' : '',
    f ? `freshness=${f.severity}(${f.ageMs != null ? Math.round(f.ageMs / 3_600_000) : '?'}h)` : 'freshness=unreadable',
  ].filter(Boolean).join(' ');
}

/** Publish the verdict to the log, the job summary and the alert step's file. */
function publishVerdict(line: string): void {
  console.log(line);
  for (const [envKey, append] of [
    ['KEEP_FRESH_SUMMARY_FILE', false],
    ['GITHUB_STEP_SUMMARY', true],
  ] as const) {
    const path = process.env[envKey]?.trim();
    if (!path) continue;
    try {
      if (append) appendFileSync(path, `${line}\n`);
      else writeFileSync(path, `${line}\n`);
    } catch {
      // Never let reporting fail the run it is reporting on.
    }
  }
}

async function main() {
  requireEnv(REQUIRED_ENV);
  const start = Date.now();
  console.log(`[keep-fresh] start · mode=${backfill ? 'backfill' : 'incremental'} limit=${limit}`);

  const outcome = await runKeepFresh(
    {
      syncWebhook: () => checkOnce(),
      index: async (): Promise<IndexerStepResult> => {
        // `result` is assigned ONLY if runIndexer returns. That single fact is
        // the page condition: a scan that threw or hit its lease deadline is a
        // fault, while a scan that finished and reported partial coverage is
        // disclosure. Counters cannot carry this — the runner builds its
        // failure outcome with no counts at all.
        let result: Awaited<ReturnType<typeof runIndexer>> | undefined;
        const job = createIndexingJob('solana', 'payments');
        const managed = await runManagedIndexingTask({ ...job, run: async (signal) => {
          result = await runIndexer(limit, { backfill, signal });
          return coverageOutcome(result.coverage, result.inserted);
        }});
        return {
          summary: result
            ? {
                fetched: result.fetched,
                inserted: result.inserted,
                queued: result.queued,
                payshSignals: result.payshSignals,
                operatorsScored: result.operatorsScored,
                unresolved: result.unresolved,
              }
            : null,
          status: managed.status,
          errorCode: 'errorCode' in managed ? managed.errorCode : undefined,
          stalled: 'stalled' in managed ? managed.stalled : false,
          completed: result !== undefined,
        };
      },
      // Arc testnet is retired; the step stays so a future re-enable inherits
      // the isolation, and so a crash here still cannot cancel the Solana path.
      indexArc: async () => {
        console.log('[keep-fresh] arc: retired — historical records are read-only');
        return { fetched: 0, inserted: 0 };
      },
      drainOnce: () => drainOnce(drainLimit, 5000),
      readLastTxIso: readLatestSolanaTransaction,
      readIndexerLastFinishedIso: async () => {
        const states = await readIndexingStates();
        return states.find((s) => s.chain === 'solana' && s.path === 'payments')?.last_finished_at ?? null;
      },
    },
    { drainBatches },
  );

  console.log(`[keep-fresh] done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  publishVerdict(verdictLine(outcome));

  if (!outcome.ok) process.exit(1);
}

main().catch((err) => {
  const reason = err instanceof Error ? err.message : String(err);
  console.error('[keep-fresh] fatal:', err);
  // A crash is the case whose page most needs a cause, and the only one where
  // no verdict exists yet — so synthesize one rather than leaving the alert to
  // fall back to "open the log".
  publishVerdict(`[keep-fresh] verdict=PAGE why="run crashed: ${reason}"`);
  process.exit(1);
});
