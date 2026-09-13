/// <reference types="bun-types" />
/**
 * LivenessIndicator — the badge every agent list renders.
 *
 * Guards the 2026-09-13 defect: `last_seen` was a row-WRITE timestamp, so the
 * 309 declared-only Arc/Celo agents (tx_count 0, backfilled 2026-06-11) all
 * crossed the 90-day threshold on 2026-09-09 and turned red "Inactive" — a
 * death verdict derived from no evidence whatsoever. Absence of observed
 * activity is its own state, not the far end of a decay curve.
 *
 * Run: bun test src/components/karma/liveness-indicator.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LivenessIndicator, LIVENESS_CONFIG } from './liveness-indicator';
import { LIVENESS_STATUSES } from '@/db/schema';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

describe('LivenessIndicator — unobserved agents', () => {
  test('no observed activity renders Unobserved, not Inactive', () => {
    const html = renderToStaticMarkup(<LivenessIndicator lastSeen={null} />);
    expect(html).toContain('Unobserved');
    expect(html).not.toContain('Inactive');
  });

  test('an omitted lastSeen renders Unobserved', () => {
    expect(renderToStaticMarkup(<LivenessIndicator />)).toContain('Unobserved');
  });

  test('Unobserved never wears the Inactive red', () => {
    const html = renderToStaticMarkup(<LivenessIndicator lastSeen={null} />);
    expect(html).not.toContain(LIVENESS_CONFIG.Inactive.dotClass);
  });

  test('Unobserved suppresses "Last active" — there is no time to report', () => {
    const html = renderToStaticMarkup(<LivenessIndicator lastSeen={null} showRelative />);
    expect(html).not.toContain('Last active');
  });
});

describe('LivenessIndicator — observed agents still decay', () => {
  test('a genuinely stale observed timestamp is still Inactive', () => {
    const html = renderToStaticMarkup(<LivenessIndicator lastSeen={hoursAgo(120 * 24)} />);
    expect(html).toContain('Inactive');
  });

  test('recent observed activity is Active and shows its relative time', () => {
    const html = renderToStaticMarkup(<LivenessIndicator lastSeen={hoursAgo(1)} showRelative />);
    expect(html).toContain('Active');
    expect(html).toContain('Last active');
  });
});

describe('LIVENESS_CONFIG exhaustiveness', () => {
  // A status with no config entry renders an empty label — silent, and invisible
  // in review. Assert the two constants against each other, not against a fixture.
  test('every LivenessStatus has a config entry', () => {
    for (const status of LIVENESS_STATUSES) {
      expect(LIVENESS_CONFIG[status]?.label).toBeTruthy();
    }
    expect(Object.keys(LIVENESS_CONFIG).sort()).toEqual([...LIVENESS_STATUSES].sort());
  });
});
