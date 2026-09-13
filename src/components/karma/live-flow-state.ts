import type { IndexingHealth, IndexingStatus, IndexingIssue } from '@/lib/indexing-health';

export interface ActivityStats {
  totalAgents: number;
  totalTransactions: number;
  freshness?: {
    stale: boolean;
    transactionsUpdatedAt: string | null;
    agentsUpdatedAt: string | null;
  };
}

export const INDEXING_STATUS_LABELS: Record<IndexingStatus, string> = {
  current: 'Up to date', running: 'Checking', catching_up: 'Catching up',
  dormant: 'No targets', disabled: 'Not enabled', failed: 'Scan failed',
  delayed: 'Delayed', unknown: 'Not yet verified',
};

export const INDEXING_ISSUE_MESSAGES: Record<IndexingIssue, string> = {
  rate_limited: 'The RPC provider limited requests. The next scheduled check will retry.',
  registry_retry: 'Some agent records could not be refreshed and remain queued for retry.',
  history_gap: 'Historical coverage is unverified. This count does not represent missing transactions.',
};

export function activityStatus(
  stats: ActivityStats | null,
  health: IndexingHealth | null,
  statsFailed: boolean,
  healthFailed: boolean,
): string {
  if (statsFailed || healthFailed || stats?.freshness?.stale || health?.status === 'failed' || health?.status === 'delayed') return 'Updates delayed';
  if (!health) return 'Checking status';
  if (health.status === 'unknown') return 'Coverage unverified';
  return INDEXING_STATUS_LABELS[health.status];
}

/** A malformed successful response must never overwrite last-known counts. */
export function parseActivityStats(value: unknown): ActivityStats {
  if (!value || typeof value !== 'object') throw new Error('Invalid activity counts');
  const stats = value as ActivityStats;
  if (!Number.isSafeInteger(stats.totalAgents) || stats.totalAgents < 0
    || !Number.isSafeInteger(stats.totalTransactions) || stats.totalTransactions < 0) throw new Error('Invalid activity counts');
  if (stats.freshness && (typeof stats.freshness.stale !== 'boolean'
    || (stats.freshness.transactionsUpdatedAt !== null && typeof stats.freshness.transactionsUpdatedAt !== 'string')
    || (stats.freshness.agentsUpdatedAt !== null && typeof stats.freshness.agentsUpdatedAt !== 'string'))) throw new Error('Invalid activity freshness');
  return stats;
}

/** Reject shape drift before the details renderer consumes any nested fields. */
export function parseActivityHealth(value: unknown): IndexingHealth {
  const health = value as IndexingHealth | null;
  const validStatus = (status: unknown) => typeof status === 'string' && Object.hasOwn(INDEXING_STATUS_LABELS, status);
  const validTime = (value: unknown) => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
  const validCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const chains = ['solana', 'arc', 'celo', 'stellar', 'arc-mainnet'];
  if (!health || !validStatus(health.status) || !validTime(health.checkedAt) || !Array.isArray(health.chains)
    || health.chains.length !== chains.length || new Set(health.chains.map((chain) => chain?.chain)).size !== chains.length
    || !health.chains.every((chain) => chain && chains.includes(chain.chain) && validStatus(chain.status)
      && Array.isArray(chain.paths) && chain.paths.length > 0 && chain.paths.every((path) => path
        && (path.issue == null || (typeof path.issue === 'string' && Object.hasOwn(INDEXING_ISSUE_MESSAGES, path.issue)))
        && typeof path.path === 'string' && typeof path.label === 'string' && validStatus(path.status)
        && validTime(path.lastCheckedAt) && validTime(path.lastSuccessAt) && validTime(path.lastAttemptAt)
        && validCount(path.checked) && validCount(path.pending) && validCount(path.unresolved) && validCount(path.inserted)))) {
    throw new Error('Invalid network coverage');
  }
  return health;
}

/** One request at a time; cleanup aborts IO and rejects any late result. */
export function startActivityPoll<T>(options: {
  load: (signal: AbortSignal) => Promise<T>;
  receive: (value: T) => void;
  failed: () => void;
  intervalMs: number;
  timeoutMs?: number;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const poll = async () => {
    const active = new AbortController();
    controller = active;
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      active.abort();
      if (!stopped) options.failed();
    }, options.timeoutMs ?? 8000);
    try {
      const value = await options.load(active.signal);
      if (!stopped && !timedOut) options.receive(value);
    } catch {
      if (!stopped && !timedOut) options.failed();
    } finally {
      clearTimeout(deadline);
      controller = undefined;
      if (!stopped) timer = setTimeout(poll, options.intervalMs);
    }
  };
  void poll();
  return () => {
    stopped = true;
    clearTimeout(timer);
    controller?.abort();
  };
}
