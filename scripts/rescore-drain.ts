/**
 * Drain the deferred scoring queue (`wallets.scoring_dirty_at`) from the CLI.
 *
 * `src/scripts/rescore-dirty.ts` is library-only — it exports `drainOnce` for
 * keep-fresh's `drain` step and has no entrypoint of its own, so there was no
 * way to work the queue down by hand. keep-fresh drains a bounded number of
 * batches per run, which is right for steady state and far too slow for a
 * backlog: enqueueing 24,115 wallets and waiting for the cron would take days.
 *
 * Progress is durable either way — every batch clears the dirty flag for the
 * wallets it scored, so stopping this mid-run loses nothing and keep-fresh
 * continues from wherever it stopped.
 *
 * Flags:
 *   --batch=N     wallets per batch (default 200)
 *   --batches=N   stop after N batches (default: until the queue is empty)
 *   --tx-window=N tx history rows per wallet (default DEFAULT_TX_WINDOW)
 *
 * Usage:
 *   bun run scripts/rescore-drain.ts --batches=1        # measure one batch
 *   bun run scripts/rescore-drain.ts                    # drain it all
 */
import { drainOnce, RESCORE_DEFAULT_BATCH_SIZE, RESCORE_DEFAULT_TX_WINDOW } from '../src/scripts/rescore-dirty';

const num = (name: string, fallback: number): number => {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const batchSize = num('batch', RESCORE_DEFAULT_BATCH_SIZE);
const txWindow = num('tx-window', RESCORE_DEFAULT_TX_WINDOW);
const maxBatches = num('batches', Number.POSITIVE_INFINITY);

const started = Date.now();
let totalScored = 0;
let totalSkipped = 0;
let totalErrors = 0;
let batches = 0;

while (batches < maxBatches) {
  const r = await drainOnce(batchSize, txWindow);
  if (r.claimed === 0) {
    console.log('[drain] queue empty');
    break;
  }
  batches++;
  totalScored += r.scored;
  totalSkipped += r.skipped;
  totalErrors += r.errors.length;

  const rate = totalScored / ((Date.now() - started) / 1000);
  const eta = rate > 0 ? Math.round(r.remaining / rate) : null;
  console.log(
    `[drain] batch ${batches}: claimed=${r.claimed} scored=${r.scored} ` +
    `skipped=${r.skipped} errors=${r.errors.length} ` +
    `remaining=${r.remaining} (${(r.elapsedMs / 1000).toFixed(1)}s, ` +
    `${rate.toFixed(1)}/s${eta != null ? `, eta ~${Math.round(eta / 60)}m` : ''})`,
  );
  // Errors are re-marked dirty by drainOnce, so a wallet that fails forever
  // would spin here. Surface the first few rather than looping in silence.
  if (r.errors.length > 0) {
    for (const e of r.errors.slice(0, 3)) console.warn(`[drain]   ${e.address}: ${e.message}`);
  }
  if (r.remaining === 0) break;
}

console.log(
  `[drain] done: ${batches} batch(es), scored=${totalScored} skipped=${totalSkipped} ` +
  `errors=${totalErrors} in ${((Date.now() - started) / 1000 / 60).toFixed(1)}m`,
);
