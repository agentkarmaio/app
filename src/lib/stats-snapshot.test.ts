import { describe, expect, test } from 'bun:test';
import {
  STATS_SNAPSHOT_VERSION,
  isStatsSnapshotFresh,
  parseStatsSnapshot,
  type StatsSnapshotPayload,
  type StatsSnapshotRow,
} from './stats-snapshot';

const row = (overrides: Partial<StatsSnapshotRow> = {}): StatsSnapshotRow => ({
  scope: 'core',
  payload: {
    version: STATS_SNAPSHOT_VERSION,
    totalAgents: 12,
    totalTransactions: 34,
    totalVolumeUsdc: 56,
    tierDistribution: { Good: 12 },
    registries: [],
    freshness: {
      stale: false,
      transactionsUpdatedAt: '2026-09-15T11:00:00.000Z',
      agentsUpdatedAt: '2026-09-15T11:00:00.000Z',
    },
  },
  as_of: '2026-09-15T11:00:00.000Z',
  completed_at: '2026-09-15T11:00:01.000Z',
  ...overrides,
});

describe('stats snapshot contract', () => {
  test('rejects snapshots from before testnet retirement', () => {
    expect(() => parseStatsSnapshot({ ...(row().payload as StatsSnapshotPayload), version: 1 })).toThrow(/Invalid stats snapshot/);
  });
  test('accepts a complete last-known-good payload', () => {
    expect(parseStatsSnapshot(row().payload)).toMatchObject({
      totalAgents: 12,
      totalTransactions: 34,
    });
  });

  test('rejects fabricated or malformed counts', () => {
    const payload = row().payload as StatsSnapshotPayload;
    expect(() => parseStatsSnapshot({ ...payload, totalTransactions: -1 })).toThrow(/Invalid stats snapshot/);
    expect(() => parseStatsSnapshot({ ...payload, totalAgents: 0.5 })).toThrow(/Invalid stats snapshot/);
    expect(() => parseStatsSnapshot({ ...payload, version: 99 })).toThrow(/Invalid stats snapshot/);
    expect(() => parseStatsSnapshot({
      ...payload,
      freshness: { ...payload.freshness, agentsUpdatedAt: 'not-a-timestamp' },
    })).toThrow(/Invalid stats snapshot/);
  });

  test('freshness is based on completed snapshot time, not request time', () => {
    expect(isStatsSnapshotFresh(row(), new Date('2026-09-15T11:00:30.000Z'), 90_000)).toBe(true);
    expect(isStatsSnapshotFresh(row(), new Date('2026-09-15T11:01:32.000Z'), 90_000)).toBe(false);
  });
});
