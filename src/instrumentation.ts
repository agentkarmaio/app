/**
 * Next.js instrumentation hook — runs once per server process at boot.
 *
 * Drives the deferred-scoring queue drain in-process so the system is
 * self-contained (no external cron service required). The webhook hot path
 * marks wallets dirty; this interval recomputes their scores off-band.
 *
 * Single-replica assumption: fine today (agentkarma runs Replicated: 1).
 * Under N replicas, N workers would all drain — harmless because
 * claimDirtyWallets + upsert + snapshot are idempotent (at worst a few
 * duplicate snapshot rows per collision).
 *
 * Tuning:
 *   SCORING_WORKER_INTERVAL_MS  default 60_000
 *   SCORING_WORKER_BATCH        default 200   (wallets per tick)
 *   SCORING_WORKER_TX_WINDOW    default 5000  (recent tx rows per wallet)
 *   SCORING_WORKER_DISABLED     set to "1" to skip registering the loop
 */

export async function register() {
  // nodejs runtime only — edge runtime has no setInterval + no DB access.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.SCORING_WORKER_DISABLED === '1') {
    console.log('[scoring-worker] disabled via env');
    return;
  }

  const intervalMs = Number(process.env.SCORING_WORKER_INTERVAL_MS) || 60_000;
  const batch      = Number(process.env.SCORING_WORKER_BATCH)       || 200;
  const txWindow   = Number(process.env.SCORING_WORKER_TX_WINDOW)   || 5000;

  // Lazy-import so Next's build/edge compilers don't pull scoring deps into
  // the client bundle or try to resolve server-only modules at build time.
  const { drainOnce } = await import('./scripts/rescore-dirty');
  const { startWatchdog } = await import('./lib/helius-watchdog');
  startWatchdog();

  let running = false;

  const tick = async () => {
    if (running) return; // skip if previous tick still draining
    running = true;
    try {
      const result = await drainOnce(batch, txWindow);
      if (result.claimed > 0 || result.errors.length > 0) {
        console.log(
          `[scoring-worker] claimed=${result.claimed} scored=${result.scored} ` +
          `skipped=${result.skipped} errors=${result.errors.length} ` +
          `remaining=${result.remaining} elapsed=${result.elapsedMs}ms`,
        );
      }
    } catch (err) {
      console.error('[scoring-worker] drain failed:', err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  // Next can tear down the server in dev/test; allow the process to exit.
  if (typeof timer.unref === 'function') timer.unref();

  console.log(
    `[scoring-worker] registered · interval=${intervalMs}ms batch=${batch} ` +
    `tx_window=${txWindow}`,
  );
  // Prime a single drain so start-up catches any queued work without waiting
  // for the first interval tick.
  void tick();
}
