export const STATS_SNAPSHOT_VERSION = 1;
export const STATS_SNAPSHOT_MAX_AGE_MS = 90_000;

export interface StatsSnapshotPayload {
  version: number;
  totalAgents: number;
  totalTransactions: number;
  totalVolumeUsdc: number;
  tierDistribution: Record<string, number>;
  registries: { chain: string; agents: number; feedbacks: number }[];
  freshness: {
    stale: boolean;
    transactionsUpdatedAt: string | null;
    agentsUpdatedAt: string | null;
  };
}

export interface StatsSnapshotRow {
  scope: string;
  payload: unknown;
  as_of: string;
  completed_at: string;
  last_failure_at?: string | null;
  next_attempt_at?: string | null;
  consecutive_failures?: number;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isFiniteAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

export function parseStatsSnapshot(value: unknown): StatsSnapshotPayload {
  if (!value || typeof value !== 'object') throw new Error('Invalid stats snapshot');
  const payload = value as Partial<StatsSnapshotPayload>;
  const tiers = payload.tierDistribution;
  const registries = payload.registries;
  const freshness = payload.freshness;
  if (payload.version !== STATS_SNAPSHOT_VERSION
    || !isCount(payload.totalAgents)
    || !isCount(payload.totalTransactions)
    || !isFiniteAmount(payload.totalVolumeUsdc)
    || !tiers || typeof tiers !== 'object'
    || !Object.values(tiers).every(isCount)
    || !Array.isArray(registries)
    || !registries.every((entry) => entry && typeof entry.chain === 'string'
      && isCount(entry.agents) && isCount(entry.feedbacks))
    || !freshness || typeof freshness.stale !== 'boolean'
    || (freshness.transactionsUpdatedAt !== null && !isTimestamp(freshness.transactionsUpdatedAt))
    || (freshness.agentsUpdatedAt !== null && !isTimestamp(freshness.agentsUpdatedAt))) {
    throw new Error('Invalid stats snapshot');
  }
  return payload as StatsSnapshotPayload;
}

export function isStatsSnapshotFresh(
  row: Pick<StatsSnapshotRow, 'completed_at'>,
  now = new Date(),
  maxAgeMs = STATS_SNAPSHOT_MAX_AGE_MS,
): boolean {
  const completedMs = Date.parse(row.completed_at);
  return Number.isFinite(completedMs)
    && completedMs <= now.getTime()
    && now.getTime() - completedMs <= maxAgeMs;
}

export function statsFromSnapshot(
  row: StatsSnapshotRow,
  now = new Date(),
): StatsSnapshotPayload {
  const payload = parseStatsSnapshot(row.payload);
  return {
    ...payload,
    freshness: {
      ...payload.freshness,
      stale: payload.freshness.stale || !isStatsSnapshotFresh(row, now),
    },
  };
}
