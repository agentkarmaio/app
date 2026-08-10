/// <reference types="bun-types" />
/**
 * Throttle detection + backoff. The load-bearing case is Arc: viem's
 * LimitExceededRpcError says "Request exceeds defined limit." — a message-only
 * check (the original Stellar-shaped `isRateLimited`) returns false for it, so
 * the arc-farm-detector crashed instead of backing off on every scheduled run
 * from 2026-07-27 to 2026-08-10.
 */
import { describe, expect, test } from 'bun:test';
import { isRateLimited, isRateLimitedError, withRateLimitRetry } from './rpc-retry';

describe('isRateLimited (message text)', () => {
  test('detects throttles', () => {
    expect(isRateLimited('Request failed with status code 429')).toBe(true);
    expect(isRateLimited('429 Too Many Requests')).toBe(true);
    expect(isRateLimited('too many requests, slow down')).toBe(true);
    expect(isRateLimited('Details: rate limit exceeded')).toBe(true);
  });

  test('does not treat reverts or timeouts as throttles', () => {
    expect(isRateLimited('HostError: Error(Contract, #2)')).toBe(false);
    expect(isRateLimited('AgentNotFound')).toBe(false);
    expect(isRateLimited('timed out after 20000ms')).toBe(false);
    expect(isRateLimited('ERC721NonexistentToken')).toBe(false);
  });
});

describe('isRateLimitedError (thrown value)', () => {
  test('detects viem LimitExceededRpcError by code, despite an unhelpful message', () => {
    const viemErr = Object.assign(new Error('Request exceeds defined limit.'), {
      code: -32005,
      details: 'rate limit exceeded',
    });
    expect(isRateLimitedError(viemErr)).toBe(true);
    // The regression itself: the message alone gives no signal.
    expect(isRateLimited(viemErr.message)).toBe(false);
  });

  test('detects a throttle carried only on the cause chain', () => {
    const wrapped = Object.assign(new Error('RPC Request failed.'), {
      cause: Object.assign(new Error('boom'), { code: -32005 }),
    });
    expect(isRateLimitedError(wrapped)).toBe(true);
  });

  test('a contract revert is never a throttle', () => {
    expect(isRateLimitedError(new Error('ERC721NonexistentToken(1)'))).toBe(false);
    expect(isRateLimitedError(Object.assign(new Error('reverted'), { code: 3 }))).toBe(false);
    expect(isRateLimitedError(null)).toBe(false);
  });
});

describe('withRateLimitRetry', () => {
  test('retries a coded rate limit until it succeeds', async () => {
    let calls = 0;
    const out = await withRateLimitRetry(
      async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error('Request exceeds defined limit.'), { code: -32005 });
        return 'ok';
      },
      { retries: 5, baseMs: 1, jitter: false },
    );
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  test('rethrows a non-throttle error immediately, without burning retries', async () => {
    let calls = 0;
    await expect(
      withRateLimitRetry(
        async () => { calls++; throw new Error('ERC721NonexistentToken'); },
        { retries: 5, baseMs: 1, jitter: false },
      ),
    ).rejects.toThrow('ERC721NonexistentToken');
    expect(calls).toBe(1);
  });

  test('gives up after the retry budget', async () => {
    let calls = 0;
    await expect(
      withRateLimitRetry(
        async () => { calls++; throw Object.assign(new Error('throttled'), { code: -32005 }); },
        { retries: 2, baseMs: 1, jitter: false },
      ),
    ).rejects.toThrow('throttled');
    expect(calls).toBe(3); // initial + 2 retries
  });
});
