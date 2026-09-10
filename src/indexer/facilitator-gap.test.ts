/// <reference types="bun-types" />
/**
 * Facilitator gap recovery — signature paging.
 *
 * 16 facilitators sit behind a cursor their indexer RPC can no longer resolve.
 * Five of them have real un-ingested history behind that cursor, two of those
 * measured at "≥1000" only because the measurement did not page — the true size
 * is unknown until something walks it.
 *
 * `getSignaturesForAddress` takes `until` AND `before` together, so the RPC
 * stops at the cursor by itself and paging is just threading `before`. The
 * failure that matters: dropping `until` on page 2 walks the address's ENTIRE
 * history instead of stopping at the gap.
 *
 * Spec: (design notes, kept out of this repo)
 * Run: bun test src/indexer/facilitator-gap.test.ts
 */

import { describe, expect, test } from 'bun:test';
import {
  pageSignaturesUntil,
  recoverFacilitatorGap,
  type GapRecoveryDeps,
} from './facilitator-gap';
import type { Transaction } from '../db/schema';

const CURSOR = 'cursor-sig-at-the-bottom-of-the-gap';

/** Fake RPC over a fixed newest-first history, honouring `before` + `until`. */
function fakeRpc(history: string[], pageSize: number) {
  const calls: Array<{ limit: number; until?: string; before?: string }> = [];
  const fetchSignatures = async (opts: { limit: number; until?: string; before?: string }) => {
    calls.push({ ...opts });
    let start = 0;
    if (opts.before) {
      const i = history.indexOf(opts.before);
      start = i === -1 ? history.length : i + 1;
    }
    let end = history.length;
    if (opts.until) {
      const i = history.indexOf(opts.until);
      if (i !== -1) end = i; // `until` is exclusive
    }
    return history.slice(start, Math.min(end, start + Math.min(opts.limit, pageSize)))
      .map((signature) => ({ signature, blockTime: 1 }));
  };
  return { fetchSignatures, calls };
}

describe('pageSignaturesUntil', () => {
  test('sends `until` on EVERY page, not just the first', async () => {
    // Dropping it on page 2 walks the whole address history — the gap becomes
    // unbounded and the run never terminates where it should.
    const history = ['s1', 's2', 's3', 's4', 's5', CURSOR, 'older1', 'older2'];
    const { fetchSignatures, calls } = fakeRpc(history, 2);

    const r = await pageSignaturesUntil(fetchSignatures, { cursor: CURSOR, pageSize: 2 });

    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(c.until).toBe(CURSOR);
    expect(r.signatures.map((s) => s.signature)).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(r.signatures.some((s) => s.signature.startsWith('older'))).toBe(false);
  });

  test('threads `before` = the oldest signature of the previous page', async () => {
    const history = ['s1', 's2', 's3', 's4', CURSOR];
    const { fetchSignatures, calls } = fakeRpc(history, 2);

    await pageSignaturesUntil(fetchSignatures, { cursor: CURSOR, pageSize: 2 });

    expect(calls[0].before).toBeUndefined();
    expect(calls[1].before).toBe('s2');
    expect(calls[2].before).toBe('s4');
  });

  test('an empty first page is the dormant case: gap 0, one call', async () => {
    const { fetchSignatures, calls } = fakeRpc([CURSOR, 'older'], 1000);
    const r = await pageSignaturesUntil(fetchSignatures, { cursor: CURSOR });

    expect(r.signatures).toEqual([]);
    expect(r.pages).toBe(1);
    expect(r.capped).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test('a short page ends the walk without a further call', async () => {
    const history = ['s1', 's2', CURSOR];
    const { fetchSignatures, calls } = fakeRpc(history, 1000);
    const r = await pageSignaturesUntil(fetchSignatures, { cursor: CURSOR, pageSize: 1000 });

    expect(r.signatures.map((s) => s.signature)).toEqual(['s1', 's2']);
    expect(calls).toHaveLength(1); // 2 < pageSize ⇒ exhausted
  });

  test('maxSignatures caps the walk and says so', async () => {
    const history = ['s1', 's2', 's3', 's4', 's5', 's6', CURSOR];
    const { fetchSignatures } = fakeRpc(history, 2);
    const r = await pageSignaturesUntil(fetchSignatures, { cursor: CURSOR, pageSize: 2, maxSignatures: 3 });

    expect(r.capped).toBe(true);
    expect(r.signatures.length).toBeLessThanOrEqual(3);
  });

  test('no cursor stored → walks from the tip, bounded by maxSignatures', async () => {
    const history = ['s1', 's2', 's3', 's4'];
    const { fetchSignatures, calls } = fakeRpc(history, 2);
    const r = await pageSignaturesUntil(fetchSignatures, { pageSize: 2, maxSignatures: 4 });

    for (const c of calls) expect(c.until).toBeUndefined();
    expect(r.signatures).toHaveLength(4);
  });
});

// ─── Recovery run ────────────────────────────────────────────────────────────
// The cursor rules are the whole safety story here: a dead cursor is the ONLY
// stored record of where a gap begins, so a partial or lossy pass must leave it
// exactly where it is.
describe('recoverFacilitatorGap', () => {
  const ADDR = 'Faci1itator22222222222222222222222222222222';

  function deps(over: Partial<GapRecoveryDeps> = {}, history = ['s1', 's2', 's3', CURSOR]) {
    const advanced: Array<[string, string]> = [];
    const persisted: Array<Omit<Transaction, 'id'>[]> = [];
    const base: GapRecoveryDeps = {
      fetchSignatures: fakeRpc(history, 1000).fetchSignatures,
      parseBatch: async (sigs) => ({
        transactions: sigs.map((signature) => ({ signature }) as never),
        requested: sigs.length, unresolved: [], undecodable: 0, recoveredFromArchive: 0,
      }),
      extract: (tx) => ({ tx_signature: (tx as { signature: string }).signature }) as never,
      persist: async (rows) => { persisted.push(rows); return rows.length; },
      advanceCursor: async (a, s) => { advanced.push([a, s]); },
      ...over,
    };
    return { base, advanced, persisted };
  }

  test('dry run reports the true gap size and writes nothing', async () => {
    const { base, persisted, advanced } = deps();
    const r = await recoverFacilitatorGap(ADDR, CURSOR, base, { dryRun: true });

    expect(r.gap).toBe(3);
    expect(r.inserted).toBe(0);
    expect(persisted).toEqual([]);
    expect(advanced).toEqual([]);
  });

  test('a clean complete pass ingests the gap and advances the cursor to its newest signature', async () => {
    const { base, advanced } = deps();
    const r = await recoverFacilitatorGap(ADDR, CURSOR, base);

    expect(r.gap).toBe(3);
    expect(r.inserted).toBe(3);
    expect(r.unresolved).toBe(0);
    expect(r.cursorAdvanced).toBe(true);
    expect(advanced).toEqual([[ADDR, 's1']]); // s1 is newest
  });

  test('persists OLDEST-first, so a killed run leaves a contiguous remainder', async () => {
    // Newest-first would leave a hole in the middle that no cursor records.
    const { base, persisted } = deps({ persist: async () => 1 }, ['s1', 's2', 's3', CURSOR]);
    const seen: string[] = [];
    await recoverFacilitatorGap(ADDR, CURSOR, {
      ...base,
      persist: async (rows) => { seen.push(...rows.map((r) => r.tx_signature)); return rows.length; },
    }, { });
    expect(seen).toEqual(['s3', 's2', 's1']);
    void persisted;
  });

  test('ANY unresolved signature leaves the cursor alone — the gap is not closed', async () => {
    const { base, advanced } = deps({
      parseBatch: async (sigs) => ({
        transactions: [], requested: sigs.length,
        unresolved: [sigs[0]], undecodable: 0, recoveredFromArchive: 0,
      }),
    });
    const r = await recoverFacilitatorGap(ADDR, CURSOR, base);

    expect(r.unresolved).toBeGreaterThan(0);
    expect(r.cursorAdvanced).toBe(false);
    expect(advanced).toEqual([]);
  });

  test('a capped walk never advances the cursor', async () => {
    // Burning the cursor here would strand everything below the cap forever.
    const { base, advanced } = deps({}, ['s1', 's2', 's3', 's4', 's5', CURSOR]);
    const r = await recoverFacilitatorGap(ADDR, CURSOR, base, { pageSize: 2, maxSignatures: 2 });

    expect(r.capped).toBe(true);
    expect(r.cursorAdvanced).toBe(false);
    expect(advanced).toEqual([]);
  });

  test('the dormant case is a no-op: gap 0, no writes, cursor untouched', async () => {
    const { base, advanced, persisted } = deps({}, [CURSOR, 'older']);
    const r = await recoverFacilitatorGap(ADDR, CURSOR, base);

    expect(r.gap).toBe(0);
    expect(r.inserted).toBe(0);
    expect(persisted).toEqual([]);
    expect(advanced).toEqual([]);
  });
});
