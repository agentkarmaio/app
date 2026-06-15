/// <reference types="bun-types" />
/**
 * Unit tests for computeSurety — Surety Karma (underwriter-quality axis).
 * Orthogonal to Provider/Consumer Karma — verified by callers, asserted here as
 * a standalone pure function.
 */

import { describe, expect, test } from 'bun:test';
import {
  computeSurety,
  RELIABLE_MIN_SCORE,
  SURETY_MIN_SETTLED_FOR_RELIABLE,
  type SuretyPosition,
} from './surety';

const settledSuccess = (stake = 100): SuretyPosition => ({ settled: true, success: true, stakeAmount: stake });
const settledFailure = (stake = 100): SuretyPosition => ({ settled: true, success: false, stakeAmount: stake });
const inFlight = (stake = 100): SuretyPosition => ({ settled: false, success: false, stakeAmount: stake });

describe('computeSurety', () => {
  test('no positions → null (no axis)', () => {
    expect(computeSurety([])).toBeNull();
  });

  test('only in-flight bonds → unproven, score 0, presence counted', () => {
    const r = computeSurety([inFlight(), inFlight()]);
    expect(r).not.toBeNull();
    expect(r!.label).toBe('unproven');
    expect(r!.score).toBe(0);
    expect(r!.inFlightCount).toBe(2);
    expect(r!.settledCount).toBe(0);
  });

  test('1/1 settled success → mixed (volume ramp blocks reliable)', () => {
    const r = computeSurety([settledSuccess()])!;
    expect(r.settledCount).toBe(1);
    expect(r.successCount).toBe(1);
    // 100% rate × (1/3) volume ramp → ~33, below RELIABLE_MIN_SCORE.
    expect(r.score).toBeLessThan(RELIABLE_MIN_SCORE);
    expect(r.label).toBe('mixed');
  });

  test('clean track record at volume → reliable', () => {
    const positions = Array.from({ length: SURETY_MIN_SETTLED_FOR_RELIABLE }, () => settledSuccess());
    const r = computeSurety(positions)!;
    expect(r.settledCount).toBe(SURETY_MIN_SETTLED_FOR_RELIABLE);
    expect(r.score).toBeGreaterThanOrEqual(RELIABLE_MIN_SCORE);
    expect(r.label).toBe('reliable');
  });

  test('poor judgment (mostly failures) → mixed, low score', () => {
    const r = computeSurety([
      settledSuccess(), settledFailure(), settledFailure(), settledFailure(),
    ])!;
    expect(r.successCount).toBe(1);
    expect(r.settledCount).toBe(4);
    expect(r.score).toBeLessThan(RELIABLE_MIN_SCORE);
    expect(r.label).toBe('mixed');
  });

  test('in-flight bonds do not inflate the settled success rate', () => {
    const withInflight = computeSurety([
      ...Array.from({ length: 3 }, () => settledSuccess()),
      inFlight(), inFlight(),
    ])!;
    const withoutInflight = computeSurety(
      Array.from({ length: 3 }, () => settledSuccess()),
    )!;
    expect(withInflight.score).toBe(withoutInflight.score);
    expect(withInflight.inFlightCount).toBe(2);
  });
});
