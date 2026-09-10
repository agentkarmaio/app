/// <reference types="bun-types" />
/**
 * Solana indexer — RPC error classification and cursor recovery.
 *
 * Two failure modes, two policies:
 *
 *  - RATE LIMIT (`isRpcRateLimited`) trips a circuit breaker: stop polling the
 *    remaining ~75 facilitators, resume next tick, never advance cursors.
 *  - UNRESOLVABLE CURSOR (`isCursorUnresolvable`) means the stored `until`
 *    signature has aged out of THIS RPC's history — permanent for that cursor,
 *    so retrying it forever is a guaranteed stall. Recovery is to re-fetch
 *    without `until` so the cursor re-anchors to a signature the RPC can see.
 *
 * Both use the EXACT error strings observed in production logs.
 *
 * Run: bun test src/indexer/index.test.ts
 */

import { describe, expect, test } from 'bun:test';
import {
  isRpcRateLimited,
  isCursorUnresolvable,
  getSignaturesWithCursorFallback,
  computeSafeCursor,
} from './index';

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

describe('isCursorUnresolvable', () => {
  // Verbatim from prod logs, 2026-07-22 — the error that stalled Solana
  // ingest for 72h. SOLANA_RPC_URL=solana-rpc.publicnode.com (free, shallow
  // history) cannot resolve a cursor signature old enough to have aged out.
  test('matches the shallow-history cursor error seen in prod logs', () => {
    const err = new Error(
      'failed to get signatures for address: Transaction ' +
      '3xLduMCBPKaUsNSZsReizmdhA9CoAa6LFDb6FRaTreqKNZnZMrf9L8wng6k3iCs5XDBYHa44BjttKmequGtpfZzc' +
      ' not found',
    );
    expect(isCursorUnresolvable(err)).toBe(true);
  });

  test('matches by JSON-RPC code -32020, on the error object or in the text', () => {
    expect(isCursorUnresolvable(Object.assign(new Error('boom'), { code: -32020 }))).toBe(true);
    expect(isCursorUnresolvable(new Error('server responded with -32020'))).toBe(true);
  });

  test('does NOT claim rate-limit or transport errors (different recovery)', () => {
    expect(isCursorUnresolvable(new Error('429 Too Many Requests'))).toBe(false);
    expect(isCursorUnresolvable(new Error('max usage reached'))).toBe(false);
    expect(isCursorUnresolvable(new Error('fetch failed'))).toBe(false);
    expect(isCursorUnresolvable(null)).toBe(false);
    expect(isCursorUnresolvable(undefined)).toBe(false);
  });
});

describe('getSignaturesWithCursorFallback', () => {
  const SIG = { signature: 'newest', slot: 1 } as never;

  test('passes the cursor through untouched when the RPC can resolve it', async () => {
    const seen: unknown[] = [];
    const result = await getSignaturesWithCursorFallback(
      async (opts) => { seen.push(opts); return [SIG]; },
      { limit: 100, until: 'old-sig' },
    );
    expect(result.signatures).toEqual([SIG]);
    expect(result.cursorReset).toBe(false);
    expect(seen).toEqual([{ limit: 100, until: 'old-sig' }]);
  });

  // THE BUG: prod returned [] here and never advanced the cursor, so every
  // hourly tick re-sent the same dead cursor. Ingest stalled permanently while
  // the specimen wallet kept transacting every ~20s.
  test('re-fetches WITHOUT the cursor when the cursor is unresolvable', async () => {
    const seen: Record<string, unknown>[] = [];
    const result = await getSignaturesWithCursorFallback(
      async (opts) => {
        seen.push(opts as Record<string, unknown>);
        if ('until' in opts) {
          throw new Error('failed to get signatures for address: Transaction old-sig not found');
        }
        return [SIG];
      },
      { limit: 100, until: 'old-sig' },
    );
    expect(result.signatures).toEqual([SIG]);
    expect(result.cursorReset).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toHaveProperty('until'); // retry drops the dead cursor
  });

  test('does not retry when there was no cursor to blame', async () => {
    let calls = 0;
    await expect(
      getSignaturesWithCursorFallback(
        async () => { calls++; throw new Error('Transaction whatever not found'); },
        { limit: 100 },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test('rethrows rate limits instead of burning the cursor on them', async () => {
    let calls = 0;
    await expect(
      getSignaturesWithCursorFallback(
        async () => { calls++; throw new Error('429 Too Many Requests'); },
        { limit: 100, until: 'old-sig' },
      ),
    ).rejects.toThrow('429');
    expect(calls).toBe(1); // circuit breaker owns this case, not the fallback
  });
});

// ─── Cursor hold on unresolvable signatures ──────────────────────────────────
// THE BUG (2026-09-10): parseTransactionsBatch dropped any signature whose
// getParsedTransaction returned null (`if (!tx) continue;`) while the cursor was
// computed from the signature LIST — `signatures[0]` — before parsing. So a
// signature the RPC could not serve was skipped AND passed by the cursor, and
// `until` never looks back: that transaction is gone.
//
// publicnode prunes `getSignaturesForAddress` and the tx store at the same ~2-day
// horizon (measured 2026-09-10), so the nulls land on the OLDEST signatures in a
// batch — exactly the ones a jump to signatures[0] skips.
describe('computeSafeCursor', () => {
  // Newest-first, as getSignaturesForAddress returns them.
  const BATCH = ['sig-0-newest', 'sig-1', 'sig-2', 'sig-3', 'sig-4-oldest'];

  test('advances to the newest signature when everything resolved', () => {
    expect(computeSafeCursor(BATCH, new Set())).toBe('sig-0-newest');
  });

  test('holds the cursor when the OLDEST signature is unresolved', () => {
    // No signature in this batch is older than the unresolved one, so there is
    // nothing safe to anchor to: the cursor must not move at all.
    expect(computeSafeCursor(BATCH, new Set(['sig-4-oldest']))).toBeNull();
  });

  test('anchors to the next-older resolved signature on a mid-batch null', () => {
    // Unresolved at index 2 → cursor must sit at index 3 so the next run
    // re-fetches 0..2. Re-processing is free (inserts upsert on tx_signature).
    expect(computeSafeCursor(BATCH, new Set(['sig-2']))).toBe('sig-3');
  });

  test('anchors below the OLDEST unresolved when several are unresolved', () => {
    expect(computeSafeCursor(BATCH, new Set(['sig-1', 'sig-3']))).toBe('sig-4-oldest');
  });

  test('ignores unresolved signatures that are not in this batch', () => {
    expect(computeSafeCursor(BATCH, new Set(['sig-from-another-facilitator'])))
      .toBe('sig-0-newest');
  });

  test('returns null for an empty batch', () => {
    expect(computeSafeCursor([], new Set())).toBeNull();
  });
});
