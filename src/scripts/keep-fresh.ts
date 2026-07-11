/**
 * keep-fresh — one orchestration that restores and maintains data freshness,
 * runnable fully OUT OF PROCESS (e.g. GitHub Actions). This is the resilient
 * layer of defense-in-depth: it survives even when the web app or its
 * in-process workers are wedged, which is exactly how the 2026-05-21 → 06-06
 * outage went unnoticed (webhook auto-disabled, in-process watchdog never
 * re-enabled it, servel cron is non-functional on this cluster).
 *
 * Steps (each reuses existing logic — no duplicated ingest/scoring code):
 *   1. Re-enable + auth-sync the Helius webhook            (checkOnce)
 *   2. Poll facilitators and ingest new txs                (runIndexer)
 *   3. Drain the deferred-scoring backlog, bounded         (drainOnce)
 *   4. Report post-run ingest freshness; exit 1 if critical (assessIngestFreshness)
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
import { getRecentTransactions } from '../db/client';
import { assessIngestFreshness } from '../lib/ingest-health';
import { requireEnv } from '../lib/require-env';
import { makeArcAdapter } from '../chain-adapters/arc';

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

  // 1. Webhook — re-enable + auth-sync (restores the real-time fast path).
  try {
    const tick = await checkOnce();
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
    console.error('[keep-fresh] webhook step failed:', err instanceof Error ? err.message : err);
  }

  // 2. Indexer — poll facilitators (the webhook-independent ingest floor).
  const idx = await runIndexer(limit, { backfill });
  console.log(
    `[keep-fresh] indexer: fetched=${idx.fetched} inserted=${idx.inserted} ` +
    `scored=${idx.scored} payshSignals=${idx.payshSignals} operatorsScored=${idx.operatorsScored}`,
  );

  // 2b. Arc — job-escrow settlements + plain USDC transfers (own try/catch so a
  // wedged Arc RPC never blocks the Solana ingest floor above). Both are
  // no-ops until their respective *_START_BLOCK env vars are set.
  try {
    const arc = await makeArcAdapter().indexReceipts();
    if (arc.inserted > 0) {
      console.log(`[keep-fresh] arc: fetched=${arc.fetched} inserted=${arc.inserted}`);
    }
  } catch (err) {
    console.error('[keep-fresh] arc step failed:', err instanceof Error ? err.message : err);
  }

  // 3. Drain the deferred-scoring backlog (bounded). Steady-state this clears
  // in one batch; the first recovery run chews through the accumulated backlog.
  let drained = 0;
  let batches = 0;
  for (let i = 0; i < drainBatches; i++) {
    const r = await drainOnce(drainLimit, 5000);
    drained += r.scored;
    batches++;
    if (r.claimed > 0 || r.errors.length > 0) {
      console.log(
        `[keep-fresh] drain ${i + 1}/${drainBatches}: claimed=${r.claimed} ` +
        `scored=${r.scored} remaining=${r.remaining} errors=${r.errors.length}`,
      );
    }
    if (r.claimed === 0 || r.remaining === 0) break;
  }
  console.log(`[keep-fresh] drain: scored=${drained} over ${batches} batch(es)`);

  // 4. Freshness verdict.
  const latest = (await getRecentTransactions(undefined, 1))[0];
  const lastTxIso = latest ? new Date(latest.timestamp as string | Date).toISOString() : null;
  const freshness = assessIngestFreshness(lastTxIso, Date.now());
  const ageH = freshness.ageMs != null ? `${Math.round(freshness.ageMs / 3_600_000)}h` : 'n/a';
  console.log(
    `[keep-fresh] freshness: ${freshness.severity} · last tx ${freshness.lastTxAt ?? 'none'} (age ${ageH}) ` +
    `· done in ${((Date.now() - start) / 1000).toFixed(1)}s`,
  );

  if (freshness.severity === 'critical') {
    console.error('[keep-fresh] STILL CRITICAL after run — ingest did not recover');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[keep-fresh] fatal:', err);
  process.exit(1);
});
