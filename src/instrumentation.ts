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
 *   SCORING_WORKER_INTERVAL_MS       default 60_000
 *   SCORING_WORKER_BATCH             default 200   (wallets per tick)
 *   SCORING_WORKER_TX_WINDOW         default 5000  (recent tx rows per wallet)
 *   SCORING_WORKER_DISABLED          set to "1" to skip registering the loop
 *   WALLET_SCAN_WORKER_INTERVAL_MS   default 30_000
 *   WALLET_SCAN_WORKER_BATCH         default 1     (wallets per tick — bounds Helius load)
 *   WALLET_SCAN_WORKER_DISABLED      set to "1" to skip registering the loop
 *   WALLET_SCAN_STALE_MS             default 600_000  (10 min — recover stuck 'scanning' rows)
 *   INDEXER_WORKER_INTERVAL_MS       default 3_600_000 (1h)
 *   INDEXER_WORKER_LIMIT             default 200   (signatures per facilitator per tick)
 *   INDEXER_WORKER_DISABLED          set to "1" to skip registering the loop
 *   HEARTBEAT_WORKER_INTERVAL_MS     default 300_000 (5m)
 *   HEARTBEAT_WORKER_BATCH           default 500   (successions per tick, all chains)
 *   HEARTBEAT_WORKER_DISABLED        set to "1" to skip registering the loop
 */

export async function register() {
  // nodejs runtime only — edge runtime has no setInterval + no DB access.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { startWatchdog } = await import('./lib/helius-watchdog');
  startWatchdog();

  await registerScoringWorker();
  await registerWalletScanWorker();
  await registerIndexerWorker();
  await registerHeartbeatWorker();
}

async function registerScoringWorker() {
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
  if (typeof timer.unref === 'function') timer.unref();

  console.log(
    `[scoring-worker] registered · interval=${intervalMs}ms batch=${batch} ` +
    `tx_window=${txWindow}`,
  );
  void tick();
}

async function registerWalletScanWorker() {
  if (process.env.WALLET_SCAN_WORKER_DISABLED === '1') {
    console.log('[wallet-scan-worker] disabled via env');
    return;
  }

  const intervalMs = Number(process.env.WALLET_SCAN_WORKER_INTERVAL_MS) || 30_000;
  const batch      = Number(process.env.WALLET_SCAN_WORKER_BATCH)       || 1;
  const staleMs    = Number(process.env.WALLET_SCAN_STALE_MS)           || 600_000;

  const { runWalletScanWorker } = await import('./indexer/wallet-scan');
  const { recoverStuckScans }   = await import('./db/client');

  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const recovered = await recoverStuckScans(staleMs);
      if (recovered > 0) {
        console.log(`[wallet-scan-worker] recovered ${recovered} stuck scans`);
      }
      await runWalletScanWorker(batch);
    } catch (err) {
      console.error('[wallet-scan-worker] tick failed:', err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  console.log(
    `[wallet-scan-worker] registered · interval=${intervalMs}ms batch=${batch} ` +
    `stale=${staleMs}ms`,
  );
  void tick();
}

async function registerIndexerWorker() {
  if (process.env.INDEXER_WORKER_DISABLED === '1') {
    console.log('[indexer-worker] disabled via env');
    return;
  }

  const intervalMs = Number(process.env.INDEXER_WORKER_INTERVAL_MS) || 3_600_000;
  const limit      = Number(process.env.INDEXER_WORKER_LIMIT)       || 200;

  // The Helius push webhook is the real-time ingest path; this incremental
  // poll is the webhook-independent FLOOR. Without it, a disabled webhook =
  // total ingest stop with no fallback (the 17-day 2026-05/06 stall). Mirrors
  // the external /api/cron/indexer + keep-fresh for the app-healthy fast path.
  const { runIndexer } = await import('./indexer/index');

  let running = false;

  const tick = async () => {
    if (running) return; // skip if previous run still going
    running = true;
    try {
      const result = await runIndexer(limit, {});
      if (result.inserted > 0 || result.scored > 0) {
        console.log(
          `[indexer-worker] fetched=${result.fetched} inserted=${result.inserted} ` +
          `scored=${result.scored} operatorsScored=${result.operatorsScored}`,
        );
      }
    } catch (err) {
      console.error('[indexer-worker] run failed:', err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  console.log(`[indexer-worker] registered · interval=${intervalMs}ms limit=${limit}`);
  void tick();
}

async function registerHeartbeatWorker() {
  if (process.env.HEARTBEAT_WORKER_DISABLED === '1') {
    console.log('[heartbeat-worker] disabled via env');
    return;
  }

  const intervalMs = Number(process.env.HEARTBEAT_WORKER_INTERVAL_MS) || 300_000;
  const batch      = Number(process.env.HEARTBEAT_WORKER_BATCH)       || 500;

  // The Dead Man's Switch liveness drain (all chains). In-process fast path; the
  // external /api/cron/heartbeat (GitHub Actions) is the webhook-independent
  // floor so a wedged app never silently stalls succession liveness.
  const { drainHeartbeatsOnce } = await import('./successions/heartbeat-worker');

  let running = false;

  const tick = async () => {
    if (running) return; // skip if previous drain still going
    running = true;
    try {
      const result = await drainHeartbeatsOnce(batch);
      if (result.transitioned > 0 || result.lapsed > 0 || result.errors.length > 0) {
        console.log(
          `[heartbeat-worker] claimed=${result.claimed} observed=${result.observed} ` +
          `lapsed=${result.lapsed} transitioned=${result.transitioned} ` +
          `skipped=${result.skipped} errors=${result.errors.length} elapsed=${result.elapsedMs}ms`,
        );
      }
    } catch (err) {
      console.error('[heartbeat-worker] drain failed:', err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  console.log(`[heartbeat-worker] registered · interval=${intervalMs}ms batch=${batch}`);
  void tick();
}
