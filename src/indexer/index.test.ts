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

import { describe, expect, test, spyOn } from 'bun:test';
import { Connection } from '@solana/web3.js';
import { __setSupabaseForTest } from '../db/client';
import * as helius from './helius';
import * as db from '../db/client';
import * as attestation from '../integrations/attestation';
import { ALL_FACILITATOR_ADDRESSES } from '../config/facilitators';
import {
  isRpcRateLimited,
  isCursorUnresolvable,
  getSignaturesWithCursorFallback,
  computeSafeCursor,
  describeCursorReset,
  runIndexer,
  fetchTransactionsForFacilitator,
} from './index';

describe('Solana run coverage', () => {
  const address = 'BfqzVwCcNf1TcVyYaZr6zjjeZKFt57fMDMcRKGjTqQCm';
  const signature = { signature: 'sig-1', slot: 1, err: null, memo: null, blockTime: 1 };
  test('late signature responses after cancellation cannot start the next facilitator', async () => {
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const signatures = spyOn(Connection.prototype, 'getSignaturesForAddress').mockImplementation(async () => {
      calls++; await gate; return [];
    });
    try {
      const pending = runIndexer(100, { backfill: true, signal: controller.signal });
      const beforeAbort = calls;
      expect(beforeAbort).toBeGreaterThan(0);
      controller.abort(Error('scan_cancelled'));
      release();
      await expect(pending).rejects.toThrow('scan_cancelled');
      expect(calls).toBe(beforeAbort);
    } finally { release(); signatures.mockRestore(); }
  });
  test('a 429 before useful work cannot be reported as complete', async () => {
    const signatures = spyOn(Connection.prototype, 'getSignaturesForAddress').mockRejectedValue(new Error('429 Too Many Requests'));
    try {
      const result = await runIndexer(100, { backfill: true });
      expect(result.fetched).toBe(0);
      expect(result.unresolved).toBe(0);
      expect(result.coverage.complete).toBe(false);
      expect(result.coverage.checked).toBe(0);
      expect(result.coverage.pending).toBeGreaterThan(0);
      expect(result.coverage.reason).toBe('rpc_rate_limited');
      expect(signatures.mock.calls.length).toBeLessThanOrEqual(5);
    } finally { signatures.mockRestore(); }
  });

  test('actually checking every target with zero matching activity is complete', async () => {
    const signatures = spyOn(Connection.prototype, 'getSignaturesForAddress').mockResolvedValue([]);
    try {
      const result = await runIndexer(100, { backfill: true });
      expect(result.fetched).toBe(0);
      expect(result.coverage.complete).toBe(true);
      expect(result.coverage.checked).toBe(signatures.mock.calls.length);
      expect(result.coverage.pending).toBe(0);
    } finally { signatures.mockRestore(); }
  });

  test('successful early targets cannot hide later quota-skipped targets', async () => {
    let calls = 0;
    const signatures = spyOn(Connection.prototype, 'getSignaturesForAddress').mockImplementation(async () => {
      if (++calls === 2) throw new Error('429 Too Many Requests');
      return [];
    });
    try {
      const result = await runIndexer(100, { backfill: true });
      expect(result.coverage.complete).toBe(false);
      expect(result.coverage.checked).toBeGreaterThan(0);
      expect(result.coverage.pending).toBeGreaterThan(0);
      expect(result.coverage.reason).toBe('rpc_rate_limited');
    } finally { signatures.mockRestore(); }
  });

  test('non-quota RPC errors remain incomplete rather than empty successful reads', async () => {
    const signatures = spyOn(Connection.prototype, 'getSignaturesForAddress').mockRejectedValue(new Error('fetch failed'));
    const log = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runIndexer(100, { backfill: true });
      expect(result.coverage.complete).toBe(false);
      expect(result.coverage.checked).toBe(0);
      expect(result.coverage.reason).toBe('rpc_unavailable');
    } finally { signatures.mockRestore(); log.mockRestore(); }
  });

  test('a cursor outside RPC retention remains unresolved even when fallback returns no signatures', async () => {
    let writes = 0;
    __setSupabaseForTest({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { last_signature: 'old-sig' }, error: null }) }) }) }), upsert: async () => { writes++; return { error: null }; } }) });
    const signatures = spyOn(Connection.prototype, 'getSignaturesForAddress').mockImplementation(async (_key, options) => {
      if (options?.until) throw new Error('Transaction old-sig not found');
      return [];
    });
    try {
      const result = await runIndexer(100);
      expect(result.coverage.complete).toBe(false);
      expect(result.coverage.pending).toBeGreaterThan(0);
      expect(result.coverage.gaps).toBeGreaterThan(0);
      expect(result.coverage.unresolved).toBe(0);
      expect(result.coverage.reason).toBe('archive_gap');
      expect(writes).toBe(0);
    } finally { signatures.mockRestore(); __setSupabaseForTest(null); }
  });

  test('a full signature page is a bounded scan with unknown older coverage', async () => {
    const signatures = spyOn(Connection.prototype, 'getSignaturesForAddress').mockResolvedValue([signature]);
    const parser = spyOn(helius, 'parseTransactionsBatch').mockResolvedValue({ transactions: [], requested: 1, unresolved: [], undecodable: 0, recoveredFromArchive: 0 });
    try {
      const result = await fetchTransactionsForFacilitator(address, 1, { until: 'old-sig' });
      expect(result.coverage).toEqual({ complete: false, checked: 1, pending: 1, unresolved: 0, gaps: 1, reason: 'scan_limit' });
      // This health change reports the existing policy without silently
      // rewriting historical cursors or extending parsing behavior.
      expect(result.cursor).toBe('sig-1');
    } finally { signatures.mockRestore(); parser.mockRestore(); }
  });

  test('archive misses remain incomplete even when no payment decoded', async () => {
    const signatures = spyOn(Connection.prototype, 'getSignaturesForAddress').mockResolvedValue([signature]);
    const parser = spyOn(helius, 'parseTransactionsBatch').mockResolvedValue({ transactions: [], requested: 1, unresolved: ['sig-1'], undecodable: 0, recoveredFromArchive: 0 });
    try {
      const result = await fetchTransactionsForFacilitator(address, 100, { until: 'old-sig' });
      expect(result.coverage).toEqual({ complete: false, checked: 1, pending: 1, unresolved: 1, gaps: 0, reason: 'scan_partial' });
      expect(result.cursor).toBeNull();
      expect(result.unresolved).toEqual(['sig-1']);
    } finally { signatures.mockRestore(); parser.mockRestore(); }
  });

  test('metadata-less records passed by the existing cursor policy remain explicit historical gaps', async () => {
    const signatures = spyOn(Connection.prototype, 'getSignaturesForAddress').mockResolvedValue([signature]);
    const parser = spyOn(helius, 'parseTransactionsBatch').mockResolvedValue({ transactions: [], requested: 1, unresolved: [], undecodable: 1, recoveredFromArchive: 0 });
    try {
      const result = await fetchTransactionsForFacilitator(address, 100, { until: 'old-sig' });
      expect(result.coverage.complete).toBe(false);
      expect(result.coverage.gaps).toBe(1);
      expect(result.coverage.unresolved).toBe(0);
      expect(result.cursor).toBe('sig-1');
    } finally { signatures.mockRestore(); parser.mockRestore(); }
  });
});

describe('Solana receipt-before-cursor ordering', () => {
  const firstAddress = ALL_FACILITATOR_ADDRESSES[0];
  const secondAddress = ALL_FACILITATOR_ADDRESSES[1];
  const signature = { signature: 'receipt-sig', slot: 1, err: null, memo: null, blockTime: 1 };

  function setup(failure?: 'receipt' | 'signal' | 'later_fetch', abort?: AbortController) {
    const events: string[] = [];
    const restores: Array<{ mockRestore: () => void }> = [];
    let parsedFirst!: () => void;
    const firstParsed = new Promise<void>(resolve => { parsedFirst = resolve; });
    restores.push(spyOn(Connection.prototype, 'getSignaturesForAddress').mockImplementation(async (key) => key.toBase58() === firstAddress ? [signature] : []));
    restores.push(spyOn(helius, 'parseTransactionsBatch').mockImplementation(async () => {
      parsedFirst();
      return { transactions: [{} as helius.HeliusEnhancedTransaction], requested: 1, unresolved: [], undecodable: 0, recoveredFromArchive: 0 };
    }));
    restores.push(spyOn(helius, 'extractX402Payment').mockReturnValue({ chain: 'solana', wallet_address: 'payer', facilitator: firstAddress, amount: 1, timestamp: '2026-09-12T00:00:00Z', success: true, tx_signature: signature.signature }));
    restores.push(spyOn(helius, 'extractPayshPayment').mockReturnValue(null));
    restores.push(spyOn(db, 'getCursor').mockImplementation(async (address) => {
      if (failure === 'later_fetch' && address === secondAddress) {
        await firstParsed;
        await Bun.sleep(5);
        throw Error('later_facilitator_aborted');
      }
      return null;
    }));
    restores.push(spyOn(db, 'upsertCursor').mockImplementation(async () => { events.push('cursor'); }));
    restores.push(spyOn(db, 'ensureWalletsExist').mockResolvedValue(undefined));
    restores.push(spyOn(db, 'insertTransactions').mockImplementation(async () => {
      events.push('receipt');
      if (failure === 'receipt') throw Error('receipt_insert_failed');
      return 1;
    }));
    restores.push(spyOn(db, 'insertSignalEvents').mockImplementation(async () => {
      events.push('signal');
      if (failure === 'signal') throw Error('signal_insert_failed');
      abort?.abort(Error('commit_cancelled'));
      return 1;
    }));
    restores.push(spyOn(db, 'getTransactionsForWallets').mockResolvedValue([]));
    restores.push(spyOn(db, 'getLatestSignalValues').mockResolvedValue(new Map()));
    restores.push(spyOn(attestation, 'readAttestations').mockResolvedValue(new Map()));
    return { events, restore: () => restores.reverse().forEach(spy => spy.mockRestore()) };
  }

  test('a later facilitator abort cannot advance the first cursor without saving its receipt', async () => {
    const fixture = setup('later_fetch');
    try {
      await expect(runIndexer(100)).rejects.toThrow('later_facilitator_aborted');
      expect(fixture.events).toEqual([]);
    } finally { fixture.restore(); }
  });

  for (const failure of ['receipt', 'signal'] as const) {
    test(`${failure} persistence failure leaves cursors available for retry`, async () => {
      const fixture = setup(failure);
      try {
        await expect(runIndexer(100)).rejects.toThrow(`${failure}_insert_failed`);
        expect(fixture.events).not.toContain('cursor');
      } finally { fixture.restore(); }
    });
  }

  test('a completed run publishes its cursor only after durable receipt and signal writes', async () => {
    const fixture = setup();
    try {
      const result = await runIndexer(100);
      expect(result.inserted).toBe(1);
      expect(fixture.events).toEqual(['receipt', 'signal', 'cursor']);
    } finally { fixture.restore(); }
  });

  test('abort after receipt persistence still prevents deferred cursor commits', async () => {
    const controller = new AbortController();
    const fixture = setup(undefined, controller);
    try {
      await expect(runIndexer(100, { signal: controller.signal })).rejects.toThrow('commit_cancelled');
      expect(fixture.events).toEqual(['receipt', 'signal']);
    } finally { fixture.restore(); }
  });
});

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

// The re-anchor warning fired identically whether the retry found 500 signatures
// or zero, and told the operator to run `keep-fresh:backfill` — measured on
// 2026-09-10 to be incapable of recovering ANY of it (every affected gap is
// 59-81 days old; the indexer RPC retains ~2 days). All 16 re-anchoring
// facilitators are in the zero-signature case.
describe('describeCursorReset', () => {
  const ADDR = 'BfqzVwCcNf1TcVyYaZr6zjjeZKFt57fMDMcRKGjTqQCm';

  test('zero signatures → info, and says the cursor is kept on purpose', async () => {
    const r = describeCursorReset(ADDR, 'dead-cursor', 0);
    expect(r.kind).toBe('zero-signatures');
    expect(r.level).toBe('info');
    expect(r.message).toContain('cursor kept as the gap anchor');
    expect(r.message).toContain(ADDR);
  });

  test('never prescribes keep-fresh:backfill — it cannot reach these gaps', async () => {
    for (const count of [0, 1, 500]) {
      expect(describeCursorReset(ADDR, 'dead-cursor', count).message).not.toContain('keep-fresh:backfill');
    }
  });

  test('a real re-anchor stays a warning and names the count', async () => {
    const r = describeCursorReset(ADDR, 'dead-cursor', 500);
    expect(r.kind).toBe('re-anchored');
    expect(r.level).toBe('warn');
    expect(r.message).toContain('500 signature(s)');
    expect(r.message).toContain('backfill-facilitator-gap');
  });
});
