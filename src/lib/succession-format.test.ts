/// <reference types="bun-types" />
/**
 * Relative-past formatting used for succession heartbeats and "last active".
 * Pins the bucket boundaries — especially the mo/y tail added for dormant agents.
 */
import { describe, expect, test } from 'bun:test';
import { formatRelativePast, formatRelativePastLong } from './succession-format';

describe('formatRelativePast', () => {
  const now = new Date('2026-06-26T12:00:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  const S = 1000;
  const MIN = 60 * S;
  const H = 60 * MIN;
  const D = 24 * H;

  test('null and unparseable → never', () => {
    expect(formatRelativePast(null, now)).toBe('never');
    expect(formatRelativePast('not-a-date', now)).toBe('never');
  });

  test('sub-minute → just now', () => {
    expect(formatRelativePast(ago(5 * S), now)).toBe('just now');
  });

  test('minutes / hours / days', () => {
    expect(formatRelativePast(ago(4 * MIN), now)).toBe('4m ago');
    expect(formatRelativePast(ago(8 * H), now)).toBe('8h ago');
    expect(formatRelativePast(ago(3 * D), now)).toBe('3d ago');
    expect(formatRelativePast(ago(29 * D), now)).toBe('29d ago');
  });

  test('months tail (≥30d, <12mo)', () => {
    expect(formatRelativePast(ago(45 * D), now)).toBe('2mo ago');
    expect(formatRelativePast(ago(200 * D), now)).toBe('7mo ago');
  });

  test('years tail (≥12mo)', () => {
    expect(formatRelativePast(ago(540 * D), now)).toBe('1y ago');
    expect(formatRelativePast(ago(800 * D), now)).toBe('2y ago');
  });

  test('future timestamps clamp to just now', () => {
    expect(formatRelativePast(ago(-60 * S), now)).toBe('just now');
  });
});

describe('formatRelativePastLong', () => {
  const now = new Date('2026-06-26T12:00:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const H = 60 * 60 * 1000;
  const D = 24 * H;

  test('null → never, sub-minute → just now', () => {
    expect(formatRelativePastLong(null, now)).toBe('never');
    expect(formatRelativePastLong(ago(5 * 1000), now)).toBe('just now');
  });

  test('verbose units across the spectrum', () => {
    expect(formatRelativePastLong(ago(8 * H), now)).toBe('8 hours ago');
    expect(formatRelativePastLong(ago(3 * D), now)).toBe('3 days ago');
    expect(formatRelativePastLong(ago(60 * D), now)).toBe('2 months ago');
    expect(formatRelativePastLong(ago(540 * D), now)).toBe('1 year ago');
  });
});
