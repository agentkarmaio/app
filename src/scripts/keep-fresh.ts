/**
 * keep-fresh — CLI for the freshness floor, runnable fully OUT OF PROCESS
 * (e.g. GitHub Actions). This is the resilient layer of defense-in-depth: it
 * survives even when the web app or its in-process workers are wedged, which is
 * exactly how the 2026-05-21 → 06-06 outage went unnoticed (webhook
 * auto-disabled, in-process watchdog never re-enabled it, servel cron is
 * non-functional on this cluster).
 *
 * This file only parses flags, wires the real implementations in, and turns the
 * outcome into an exit code. The step sequence — and the rule that one failed
 * step must not end the run — lives in `src/lib/keep-fresh.ts`, where it is
 * testable (mirrors indexer/run.ts → indexer/index.ts).
 *
 * Steps (each reuses existing logic — no duplicated ingest/scoring code):
 *   1. Re-enable + auth-sync the Helius webhook            (checkOnce)
 *   2. Poll facilitators and ingest new txs                (runIndexer)
 *   2b. Arc job-escrow settlements + USDC transfers        (arc adapter)
 *   3. Drain the deferred-scoring backlog, bounded         (drainOnce)
 *   4. Report post-run ingest freshness                    (assessIngestFreshness)
 *
 * Exits 1 when any step failed or ingest is critically stale, so the workflow's
 * `if: failure()` Telegram page still fires — now naming the step that broke.
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
 */

import { checkOnce } from '../lib/helius-watchdog';
import { runIndexer } from '../indexer/index';
import { drainOnce } from './rescore-dirty';
import { createIndexingJob, runIndexingJob, runManagedIndexingTask, readLatestSolanaTransaction, coverageOutcome } from '../lib/indexing-jobs';
import { runKeepFresh } from '../lib/keep-fresh';
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

async function main() {
  requireEnv(REQUIRED_ENV);
  const start = Date.now();
  console.log(`[keep-fresh] start · mode=${backfill ? 'backfill' : 'incremental'} limit=${limit}`);

  const outcome = await runKeepFresh(
    {
      syncWebhook: () => checkOnce(),
      index: async () => {
        let result: Awaited<ReturnType<typeof runIndexer>> | undefined;
        const job = createIndexingJob('solana', 'payments');
        const managed = await runManagedIndexingTask({ ...job, run: async (signal) => {
          result = await runIndexer(limit, { backfill, signal });
          return coverageOutcome(result.coverage, result.inserted);
        }});
        if (managed.status === 'failed' || managed.status === 'lease_lost' || ('gapCount' in managed && (managed.gapCount ?? 0) > 0)) throw Error('solana_scan_failed');
        return result ?? { fetched: 0, inserted: 0, scored: 0, payshSignals: 0, operatorsScored: 0, unresolved: 0, skipped: 'already_running' };
      },
      // No-op until ARC_JOBS_START_BLOCK / ARC_TRANSFERS_START_BLOCK are set.
      indexArc: async () => {
        const result = await runIndexingJob('arc', 'escrow');
        if (result.status === 'failed' || result.status === 'lease_lost' || ('gapCount' in result && (result.gapCount ?? 0) > 0)) throw Error('arc_scan_failed');
        return { fetched: 0, inserted: 'insertedCount' in result ? result.insertedCount ?? 0 : 0 };
      },
      drainOnce: () => drainOnce(drainLimit, 5000),
      readLastTxIso: readLatestSolanaTransaction,
    },
    { drainBatches },
  );

  console.log(`[keep-fresh] done in ${((Date.now() - start) / 1000).toFixed(1)}s`);

  if (outcome.failedSteps.length > 0) {
    console.error(`[keep-fresh] FAILED steps: ${outcome.failedSteps.join(', ')} — other steps completed`);
    process.exit(1);
  }
  if (outcome.freshness?.severity === 'critical') {
    console.error('[keep-fresh] STILL CRITICAL after run — ingest did not recover');
    process.exit(1);
  }
  if ((outcome.indexer?.unresolved ?? 0) > 0 || ((outcome.indexer as {coverage?:{gaps?:number}} | null)?.coverage?.gaps ?? 0) > 0) {
    console.error(
      `[keep-fresh] DEGRADED — ${outcome.indexer?.unresolved} signature(s) unserved by every RPC`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[keep-fresh] fatal:', err);
  process.exit(1);
});
