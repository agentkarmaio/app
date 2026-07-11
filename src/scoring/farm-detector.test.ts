/// <reference types="bun-types" />
/**
 * Farm-detector — pure ratio evaluation tests.
 *
 * See docs/superpowers/specs/2026-07-11-arc-farm-detector-design.md. This
 * module only judges pre-computed sample counts against fixed thresholds; the
 * RPC/DB sampling that produces those counts lives in scripts/arc-farm-detector.ts
 * (untested glue, same convention as arc-backfill-agents.ts).
 *
 * Run: bun test src/scoring/farm-detector.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { evaluateFarmSignals, type FarmSamples } from './farm-detector';

const HEALTHY: FarmSamples = {
  bulkMintSample: { total: 50, templated: 2 },
  settlementSample: { total: 20, selfDealt: 1, templated: 1 },
  feedbackSample: { total: 20, allPositive: 3 },
};

describe('evaluateFarmSignals', () => {
  test('healthy ratios across all three samples → not flagged', () => {
    const r = evaluateFarmSignals(HEALTHY);
    expect(r.flagged).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  test('zero samples everywhere → not flagged (nothing to judge)', () => {
    const r = evaluateFarmSignals({
      bulkMintSample: { total: 0, templated: 0 },
      settlementSample: { total: 0, selfDealt: 0, templated: 0 },
      feedbackSample: { total: 0, allPositive: 0 },
    });
    expect(r.flagged).toBe(false);
  });

  test('high bulk-mint template ratio flags with a specific reason', () => {
    const r = evaluateFarmSignals({
      ...HEALTHY,
      bulkMintSample: { total: 50, templated: 20 }, // 40%
    });
    expect(r.flagged).toBe(true);
    expect(r.bulkMintRatio).toBeCloseTo(0.4, 5);
    expect(r.reasons.some((s) => s.includes('bulk-mint'))).toBe(true);
  });

  test('majority self-dealt settlements flags with a specific reason', () => {
    const r = evaluateFarmSignals({
      ...HEALTHY,
      settlementSample: { total: 10, selfDealt: 6, templated: 0 }, // 60%
    });
    expect(r.flagged).toBe(true);
    expect(r.selfDealtRatio).toBeCloseTo(0.6, 5);
    expect(r.reasons.some((s) => s.includes('self-dealt'))).toBe(true);
  });

  test('high templated-counterparty ratio in settlements flags', () => {
    const r = evaluateFarmSignals({
      ...HEALTHY,
      settlementSample: { total: 10, selfDealt: 0, templated: 4 }, // 40%
    });
    expect(r.flagged).toBe(true);
    expect(r.templatedSettlementRatio).toBeCloseTo(0.4, 5);
    expect(r.reasons.some((s) => s.includes('templated counterpart'))).toBe(true);
  });

  test('suspiciously high 100%-positive-feedback ratio flags, but only above the min sample size', () => {
    const tiny = evaluateFarmSignals({
      ...HEALTHY,
      feedbackSample: { total: 3, allPositive: 3 }, // 100%, but n=3 too small to judge
    });
    expect(tiny.flagged).toBe(false);

    const meaningful = evaluateFarmSignals({
      ...HEALTHY,
      feedbackSample: { total: 20, allPositive: 16 }, // 80%, n=20
    });
    expect(meaningful.flagged).toBe(true);
    expect(meaningful.allPositiveFeedbackRatio).toBeCloseTo(0.8, 5);
    expect(meaningful.reasons.some((s) => s.includes('100%-positive'))).toBe(true);
  });

  test('multiple crossed thresholds all appear in reasons', () => {
    const r = evaluateFarmSignals({
      bulkMintSample: { total: 50, templated: 25 },
      settlementSample: { total: 10, selfDealt: 7, templated: 0 },
      feedbackSample: { total: 20, allPositive: 3 },
    });
    expect(r.flagged).toBe(true);
    expect(r.reasons.length).toBe(2); // bulk-mint + self-dealt, not feedback
  });
});
