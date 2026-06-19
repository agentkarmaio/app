/// <reference types="bun-types" />
/**
 * Solana indexer — RPC rate-limit detection for the circuit breaker.
 *
 * The breaker stops polling the remaining ~75 facilitators once the RPC reports
 * quota exhaustion. `isRpcRateLimited` is the predicate that trips it; these
 * cases use the EXACT Helius error strings observed in production logs.
 *
 * Run: bun test src/indexer/index.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { isRpcRateLimited } from './index';

describe('isRpcRateLimited', () => {
  test('matches the Helius quota-exhaustion error seen in prod logs', () => {
    const err = new Error(
      '429 Too Many Requests: {"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"}}',
    );
    expect(isRpcRateLimited(err)).toBe(true);
  });

  test('matches by code, message, or generic 429 wording', () => {
    expect(isRpcRateLimited(new Error('-32429'))).toBe(true);
    expect(isRpcRateLimited(new Error('max usage reached'))).toBe(true);
    expect(isRpcRateLimited(new Error('Too Many Requests'))).toBe(true);
    expect(isRpcRateLimited(new Error('rate limit exceeded'))).toBe(true);
    expect(isRpcRateLimited('429')).toBe(true); // non-Error input
  });

  test('does NOT trip on unrelated RPC errors (those should keep scanning)', () => {
    expect(isRpcRateLimited(new Error('fetch failed'))).toBe(false);
    expect(isRpcRateLimited(new Error('Invalid param: address'))).toBe(false);
    expect(isRpcRateLimited(null)).toBe(false);
    expect(isRpcRateLimited(undefined)).toBe(false);
  });
});
