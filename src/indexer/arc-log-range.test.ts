import { describe, expect, test } from 'bun:test';
import { isArcLogRangeError, arcIndexCoverage, withArcLogRetry, readArcLogRange, ARC_LOG_RANGE_MAX_REQUESTS, ARC_LOG_BUDGET_EXHAUSTED } from './arc-log-range';

describe('Arc log range recovery', () => {
  test('recognizes nested provider range and result errors but not generic throttles or authorization', () => {
    expect(isArcLogRangeError({ cause: { code: 35, message: 'block range is too large' } })).toBe(true);
    expect(isArcLogRangeError({ code: -32005, details: 'query returned more than 20000 results' })).toBe(true);
    expect(isArcLogRangeError({ code: 35, message: 'authorization failed' })).toBe(false);
    expect(isArcLogRangeError({ code: -32005, message: 'rate limit exceeded' })).toBe(false);
    expect(isArcLogRangeError(new Error('HTTP 400'))).toBe(false);
    const circular: { cause?: unknown } = {};
    circular.cause = circular;
    expect(isArcLogRangeError(circular)).toBe(false);
  });

  test('bounds recovery requests even when single blocks succeed', async () => {
    let calls = 0;
    await expect(readArcLogRange(0n, 9999n, async (from, to) => {
      calls++;
      if (from !== to) throw new Error('block range is too large');
      return [from];
    }, (a, b) => [...a, ...b])).rejects.toThrow('recovery limit');
    expect(calls).toBe(ARC_LOG_RANGE_MAX_REQUESTS);
  });

  test('stops subdivision at deadline before starting another request', async () => {
    let expired = false;
    let calls = 0;
    await expect(readArcLogRange(0n, 99n, async () => {
      calls++;
      expired = true;
      throw new Error('block range is too large');
    }, (a, _b) => a, () => expired)).rejects.toBe(ARC_LOG_BUDGET_EXHAUSTED);
    expect(calls).toBe(1);
  });
});

test('recognizes the exact dRPC free-plan range rejection', () => {
  expect(isArcLogRangeError({ code: 35, message: 'ranges over 10000 blocks are not supported on free plan' })).toBe(true);
});


test('range failures bypass throttle backoff while real throttles are retried', async () => {
  let rangeCalls = 0;
  const denied = Object.assign(new Error('query returned more than 20000 results'), { code: -32005 });
  await expect(withArcLogRetry(async () => { rangeCalls++; throw denied; }, { retries: 2, baseMs: 0 })).rejects.toBe(denied);
  expect(rangeCalls).toBe(1);
  let throttleCalls = 0;
  const result = await withArcLogRetry(async () => {
    if (++throttleCalls === 1) throw Object.assign(new Error('rate limit exceeded'), { code: -32005 });
    return 'ok';
  }, { retries: 2, baseMs: 0 });
  expect(result).toBe('ok');
  expect(throttleCalls).toBe(2);
});


test('coverage distinguishes being at head from a stale provider behind the saved cursor', () => {
  expect(arcIndexCoverage(100n, 121n, 120n, 120)).toEqual({ complete: false, head: '100', checkpoint: '120', checked: 0, pending: 0, unresolved: 1, reason: 'head_behind_cursor' });
  expect(arcIndexCoverage(120n, 121n, 120n, 120)).toEqual({ complete: true, head: '120', checkpoint: '120', checked: 0, pending: 0, unresolved: 0 });
});
