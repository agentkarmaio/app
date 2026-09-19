import type { Chain } from '@/db/schema';
import type { IndexingPath } from './indexing-health';

export interface ScanOutcome {
  status: 'caught_up' | 'catching_up' | 'dormant' | 'failed';
  errorCode?: string;
  checkpoint?: string | null;
  head?: string | null;
  checkedCount?: number;
  pendingCount?: number;
  insertedCount?: number;
  unresolvedCount?: number;
  gapCount?: number;
}
export interface JobIdentity {
  chain: Chain;
  path: IndexingPath;
  owner: string;
}
export interface IndexingJob {
  chain: Chain;
  path: IndexingPath;
  intervalMs: number;
  timeoutMs?: number;
  run: (signal: AbortSignal) => Promise<ScanOutcome>;
}
export interface LeaseDependencies {
  acquire: (
    identity: JobIdentity & { leaseMs: number; intervalMs: number },
  ) => Promise<boolean>;
  renew: (identity: JobIdentity & { leaseMs: number }) => Promise<boolean>;
  finish: (identity: JobIdentity & ScanOutcome) => Promise<boolean>;
  /** Hand ownership back without a result; works after the lease expired. */
  release: (identity: JobIdentity) => Promise<boolean>;
  withContext: <T>(
    identity: JobIdentity & { signal: AbortSignal },
    fn: () => Promise<T>,
  ) => Promise<T>;
}
const ERROR_CODES = new Set([
  'scan_timeout',
  'lease_lost',
  'rpc_rate_limited',
  'rpc_range_rejected',
  'rpc_unavailable',
  'rpc_authentication_failed',
  'rpc_chain_mismatch',
  'configuration_invalid',
  'configuration_missing',
  'scan_failed',
  'unmatched',
  'all_absent',
  'scan_limit',
  'empty_seed',
  'scan_partial',
  'score_refresh_pending',
  'budget',
  'rate_limited',
  'time_budget',
  'window_limit',
  'batch_limit',
  'registry_read_failure',
  'retry_backlog',
  'address_failure',
  'head_behind_cursor',
  'archive_gap',
  'coverage_gap',
]);
export function indexingErrorCode(error: unknown): string {
  // Supabase/PostgREST and fetch adapters commonly return plain objects rather
  // than Error instances. String(object) loses the actionable code/message and
  // turns database timeouts and rate limits into the generic scan_failed label.
  const structured = error && typeof error === 'object' ? error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  } : null;
  const code = typeof structured?.code === 'string' ? structured.code : '';
  const message = typeof structured?.message === 'string' ? structured.message : '';
  const m = error instanceof Error ? error.message : message || String(error);
  if (code === '57014') return 'rpc_unavailable';
  if (/PGRST301|jwt|authentication|unauthorized|forbidden/i.test(`${code} ${m}`)) return 'rpc_authentication_failed';
  if (/^429$|429|rate.limit|quota|max usage/i.test(`${code} ${m}`)) return 'rpc_rate_limited';
  if (m === 'arc_mainnet_chain_mismatch') return 'rpc_chain_mismatch';
  if (m === 'arc_mainnet_rpc_missing') return 'configuration_missing';
  if (['arc_mainnet_rpc_invalid', 'arc_mainnet_start_invalid', 'arc_mainnet_seed_invalid', 'arc_mainnet_seed_limit'].includes(m)) return 'configuration_invalid';
  if (ERROR_CODES.has(m)) return m;
  if (/429|rate.limit|quota|max usage/i.test(m)) return 'rpc_rate_limited';
  if (/range.*block|block.*range/i.test(m)) return 'rpc_range_rejected';
  if (/env|not set|must be set|not configured/i.test(m))
    return 'configuration_missing';
  if (/rpc|fetch|network|timeout|timed out/i.test(m)) return 'rpc_unavailable';
  return 'scan_failed';
}
/**
 * Leases this process holds right now. A run that ends — however it ends —
 * removes its own entry, so whatever remains here at shutdown is exactly what
 * would otherwise be orphaned.
 */
const held = new Map<string, { identity: JobIdentity; release: LeaseDependencies['release'] }>();
const heldKey = (i: JobIdentity) => `${i.chain}/${i.path}/${i.owner}`;

/**
 * Release every lease still in flight, for a process that is going away.
 * Returns how many the store actually cleared. Safe to call more than once:
 * an already-released lease is simply no longer held.
 */
export async function releaseHeldIndexingLeases(): Promise<number> {
  const entries = [...held.values()];
  held.clear();
  const results = await Promise.allSettled(
    entries.map((e) => e.release(e.identity)),
  );
  return results.filter((r) => r.status === 'fulfilled' && r.value).length;
}

/** Ownership is enforced again by DB triggers on every context-bearing write. */
export async function executeIndexingJob(
  job: IndexingJob,
  deps: LeaseDependencies,
  opts: { renewMs?: number; timeoutMs?: number } = {},
) {
  const identity = {
    chain: job.chain,
    path: job.path,
    owner: crypto.randomUUID(),
  };
  const leaseMs = 90_000;
  if (
    !(await deps.acquire({ ...identity, leaseMs, intervalMs: job.intervalMs }))
  )
    return { status: 'busy' as const };
  held.set(heldKey(identity), { identity, release: deps.release });
  const controller = new AbortController();
  let lost = false;
  let renewing = false;
  let stop: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let outcome: ScanOutcome;
  try {
    outcome = await deps.withContext(
      { ...identity, signal: controller.signal },
      async () => {
        const cancelled = new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(Error(lost ? 'lease_lost' : 'scan_timeout')),
            { once: true },
          );
          stop = setTimeout(
            () => controller.abort(),
            opts.timeoutMs ?? job.timeoutMs ?? 180_000,
          );
        });
        heartbeat = setInterval(() => {
          if (renewing || controller.signal.aborted) return;
          renewing = true;
          void deps
            .renew({ ...identity, leaseMs })
            .then(
              (ok) => {
                if (!ok) {
                  lost = true;
                  controller.abort();
                }
              },
              () => {
                lost = true;
                controller.abort();
              },
            )
            .finally(() => {
              renewing = false;
            });
        }, opts.renewMs ?? 30_000);
        const result = await Promise.race([
          job.run(controller.signal),
          cancelled,
        ]);
        if (controller.signal.aborted)
          throw Error(lost ? 'lease_lost' : 'scan_timeout');
        return result;
      },
    );
  } catch (error) {
    outcome = { status: 'failed', errorCode: indexingErrorCode(error) };
  } finally {
    clearTimeout(stop);
    clearInterval(heartbeat);
    // Blocks later network calls from work that did not honour cancellation.
    controller.abort();
  }
  held.delete(heldKey(identity));
  // Every exit that does NOT go through `finish` must hand the lease back
  // itself: `finish_indexing_run` is the only other writer that clears
  // ownership, and it refuses once the lease has expired — exactly when a
  // lost run needs it. Left undone, the row shows a phantom owner until the
  // next acquire steals it, a whole interval later.
  if (lost) {
    await releaseQuietly(deps, identity);
    return { status: 'lease_lost' as const, errorCode: 'lease_lost' };
  }
  if (outcome.errorCode && !ERROR_CODES.has(outcome.errorCode))
    outcome = { ...outcome, errorCode: 'scan_partial' };
  const finished = await deps.finish({ ...identity, ...outcome });
  if (finished) return outcome;
  await releaseQuietly(deps, identity);
  return { status: 'lease_lost' as const, errorCode: 'lease_lost' };
}

/**
 * A lease we failed to give back is the state we were already in, so this never
 * fails a run. It warns once, though: a missing RPC or a stale PostgREST schema
 * cache would otherwise make the whole release path silently inert.
 */
let releaseFailureLogged = false;
async function releaseQuietly(deps: LeaseDependencies, identity: JobIdentity) {
  try {
    await deps.release(identity);
  } catch (error) {
    if (releaseFailureLogged) return;
    releaseFailureLogged = true;
    console.warn(
      `[indexing] lease release unavailable (${indexingErrorCode(error)}); orphans clear on the next acquire`,
    );
  }
}
