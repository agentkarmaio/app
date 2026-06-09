import { describe, expect, test } from 'bun:test';
import {
  assessIngestFreshness,
  FRESHNESS_WARNING_MS,
  FRESHNESS_CRITICAL_MS,
} from './ingest-health';

// Regression guard for the 2026-05/06 silent ingest stall: the Helius webhook
// auto-disabled on 2026-05-21 and nothing detected that the last transaction
// was 17 days old. assessIngestFreshness encodes the staleness detection that
// was missing — the system can now SEE it is stale and alert/recover.
describe('assessIngestFreshness', () => {
  // Fixed reference instant so the test is deterministic.
  const NOW = new Date('2026-06-06T20:00:00.000Z').getTime();

  test('flags the real 17-day outage as critical + stale', () => {
    const report = assessIngestFreshness('2026-05-20T16:34:36.000Z', NOW);
    expect(report.severity).toBe('critical');
    expect(report.stale).toBe(true);
    expect(report.ageMs).toBeGreaterThan(FRESHNESS_CRITICAL_MS);
    expect(report.lastTxAt).toBe('2026-05-20T16:34:36.000Z');
  });

  test('treats a just-ingested tx as fresh', () => {
    const oneMinAgo = new Date(NOW - 60_000).toISOString();
    const report = assessIngestFreshness(oneMinAgo, NOW);
    expect(report.severity).toBe('fresh');
    expect(report.stale).toBe(false);
  });

  test('warns between the warning and critical thresholds', () => {
    const threeHoursAgo = new Date(NOW - 3 * 60 * 60 * 1000).toISOString();
    const report = assessIngestFreshness(threeHoursAgo, NOW);
    expect(report.severity).toBe('warning');
    expect(report.stale).toBe(true);
    expect(report.ageMs).toBeGreaterThanOrEqual(FRESHNESS_WARNING_MS);
    expect(report.ageMs).toBeLessThan(FRESHNESS_CRITICAL_MS);
  });

  test('reports unknown + stale when there is no last-tx timestamp', () => {
    const report = assessIngestFreshness(null, NOW);
    expect(report.severity).toBe('unknown');
    expect(report.stale).toBe(true);
    expect(report.ageMs).toBeNull();
    expect(report.lastTxAt).toBeNull();
  });

  test('reports unknown for an unparseable timestamp', () => {
    const report = assessIngestFreshness('not-a-date', NOW);
    expect(report.severity).toBe('unknown');
    expect(report.stale).toBe(true);
    expect(report.ageMs).toBeNull();
  });

  test('clamps a future timestamp to fresh (clock skew)', () => {
    const future = new Date(NOW + 5 * 60_000).toISOString();
    const report = assessIngestFreshness(future, NOW);
    expect(report.severity).toBe('fresh');
    expect(report.stale).toBe(false);
    expect(report.ageMs).toBe(0);
  });

  test('honors custom thresholds', () => {
    const tenMinAgo = new Date(NOW - 10 * 60_000).toISOString();
    const report = assessIngestFreshness(tenMinAgo, NOW, {
      warningMs: 5 * 60_000,
      criticalMs: 60 * 60_000,
    });
    expect(report.severity).toBe('warning');
    expect(report.stale).toBe(true);
  });
});
