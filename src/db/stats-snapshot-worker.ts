import { supabase, getLiveStats } from './client';
import { indexingErrorCode } from '@/lib/indexing-runner';
import { STATS_SNAPSHOT_VERSION } from '@/lib/stats-snapshot';

// Keep the interval below the 90s freshness budget. A worker failure still
// serves the previous payload, but a healthy worker should not label every
// successful snapshot as delayed between ticks.
const DEFAULT_INTERVAL_MS = 60_000;
const LEASE_MS = 120_000;

export async function refreshStatsSnapshot(): Promise<'published' | 'busy'> {
  const owner = crypto.randomUUID();
  const claim = await supabase.rpc('claim_stats_snapshot', {
    p_scope: 'core', p_owner: owner, p_lease_ms: LEASE_MS,
  });
  if (claim.error) throw claim.error;
  const generation = Number((claim.data as { generation?: number }[] | null)?.[0]?.generation);
  if (!Number.isSafeInteger(generation)) return 'busy';

  try {
    const stats = await getLiveStats();
    const payload = { ...stats, version: STATS_SNAPSHOT_VERSION };
    const published = await supabase.rpc('publish_stats_snapshot', {
      p_scope: 'core', p_owner: owner, p_generation: generation,
      p_payload: payload, p_as_of: new Date().toISOString(),
    });
    if (published.error) throw published.error;
    if (published.data !== true) return 'busy';
    return 'published';
  } catch (error) {
    const failed = await supabase.rpc('fail_stats_snapshot', {
      p_scope: 'core', p_owner: owner, p_generation: generation,
      p_error_code: indexingErrorCode(error),
    });
    if (failed.error) console.error('[stats-snapshot-worker] failed to record failure:', failed.error.message);
    throw error;
  }
}

export function startStatsSnapshotWorker(): void {
  if (process.env.STATS_SNAPSHOT_WORKER_DISABLED === '1') {
    console.log('[stats-snapshot-worker] disabled via env');
    return;
  }
  const intervalMs = Number(process.env.STATS_SNAPSHOT_WORKER_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await refreshStatsSnapshot();
      if (result === 'published') console.log('[stats-snapshot-worker] published core snapshot');
    } catch (error) {
      console.error('[stats-snapshot-worker] refresh failed:', error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[stats-snapshot-worker] registered · interval=${intervalMs}ms`);
  void tick();
}
