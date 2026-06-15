/// <reference types="bun-types" />
/**
 * Unit tests for deriveSuccessionLiveness + heartbeatStrength — Dead Man's
 * Switch status derivation. Pure functions; deterministic via injected `now`.
 */

import { describe, expect, test } from 'bun:test';
import {
  deriveSuccessionLiveness,
  heartbeatStrength,
  LAPSING_GRACE_FRACTION,
} from './succession';
import type { Succession } from '@/db/schema';

const NOW = new Date('2026-06-15T12:00:00Z');
const DAY = 86_400;

function succ(status: Succession['status'], intervalSeconds: number) {
  return { status, interval_seconds: intervalSeconds };
}

function tsAgo(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1000).toISOString();
}

describe('deriveSuccessionLiveness', () => {
  test('tx within interval → live, echoes heartbeat', () => {
    const r = deriveSuccessionLiveness({
      succession: succ('declared', 7 * DAY),
      lastMeaningfulTxAt: tsAgo(2 * DAY),
      now: NOW,
    });
    expect(r.status).toBe('live');
    expect(r.heartbeatLastAt).toBe(tsAgo(2 * DAY));
    expect(r.deadlineAt).not.toBeNull();
  });

  test('past interval but within grace band → lapsing', () => {
    const interval = 7 * DAY;
    // 1.2× interval → past deadline, inside the 1.5× grace band.
    const r = deriveSuccessionLiveness({
      succession: succ('live', interval),
      lastMeaningfulTxAt: tsAgo(Math.floor(interval * 1.2)),
      now: NOW,
    });
    expect(r.status).toBe('lapsing');
  });

  test('past grace band → lapsed', () => {
    const interval = 7 * DAY;
    const r = deriveSuccessionLiveness({
      succession: succ('lapsing', interval),
      lastMeaningfulTxAt: tsAgo(Math.floor(interval * (1 + LAPSING_GRACE_FRACTION) + 1000)),
      now: NOW,
    });
    expect(r.status).toBe('lapsed');
  });

  test('no observed tx → declared baseline, null heartbeat', () => {
    const r = deriveSuccessionLiveness({
      succession: succ('declared', 7 * DAY),
      lastMeaningfulTxAt: null,
      now: NOW,
    });
    expect(r.status).toBe('declared');
    expect(r.heartbeatLastAt).toBeNull();
    expect(r.secondsSinceHeartbeat).toBeNull();
  });

  test('executed is a terminal fact — overrides liveness inference', () => {
    // Even with a very recent tx (would read live), executed wins.
    const r = deriveSuccessionLiveness({
      succession: succ('executed', 7 * DAY),
      lastMeaningfulTxAt: tsAgo(60),
      now: NOW,
    });
    expect(r.status).toBe('executed');
  });

  test('revoked is a terminal fact — overrides liveness inference', () => {
    const r = deriveSuccessionLiveness({
      succession: succ('revoked', 7 * DAY),
      lastMeaningfulTxAt: tsAgo(100 * DAY),
      now: NOW,
    });
    expect(r.status).toBe('revoked');
  });
});

describe('heartbeatStrength', () => {
  test('well within interval → full strength', () => {
    expect(heartbeatStrength(0.2 * 7 * DAY, 7 * DAY)).toBe(1.0);
  });

  test('well past interval → zero strength', () => {
    expect(heartbeatStrength(2 * 7 * DAY, 7 * DAY)).toBe(0.0);
  });

  test('decays monotonically between 0.5x and 1.5x interval', () => {
    const i = 7 * DAY;
    const mid = heartbeatStrength(i, i); // ratio 1.0 → 0.5
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(heartbeatStrength(0.8 * i, i)).toBeGreaterThan(heartbeatStrength(1.2 * i, i));
  });

  test('zero interval → zero (no divide-by-zero)', () => {
    expect(heartbeatStrength(100, 0)).toBe(0);
  });
});
