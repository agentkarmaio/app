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

// 14,019 signatures against a rate-limited endpoint will outlive a CI job's
// timeout. Progress therefore has to survive the kill: the cursor moves up
// behind the contiguous clean prefix as batches land, so a re-run pages only
// what is left instead of re-walking from the dead cursor every time.
describe('recoverFacilitatorGap resumability', () => {
  const ADDR = 'Faci1itator22222222222222222222222222222222';

  test('advances the cursor per batch, following the ingested prefix upward', async () => {
    const history = ['s1', 's2', 's3', 's4', CURSOR]; // newest-first
    const advanced: string[] = [];
    await recoverFacilitatorGap(ADDR, CURSOR, {
      fetchSignatures: fakeRpc(history, 1000).fetchSignatures,
      parseBatch: async (sigs) => ({
        transactions: sigs.map((signature) => ({ signature }) as never),
        requested: sigs.length, unresolved: [], undecodable: 0, recoveredFromArchive: 0,
      }),
      extract: (tx) => ({ tx_signature: (tx as { signature: string }).signature }) as never,
      persist: async (rows) => rows.length,
      advanceCursor: async (_a, s) => { advanced.push(s); },
    }, { batchSize: 2 });

    // Ingest order is oldest-first (s4, s3, s2, s1), so the cursor climbs.
    expect(advanced).toEqual(['s3', 's1']);
  });

  test('stops advancing at the first batch with an unresolved signature', async () => {
    // Everything above the break is NOT contiguous with the cursor; moving past
    // it would strand the unresolved signature exactly like the original bug.
    const history = ['s1', 's2', 's3', 's4', CURSOR];
    const advanced: string[] = [];
    // PERSISTENT miss — one that survives the retry pass. A transient miss is a
    // different case and is covered below: it must NOT cost the run its prefix.
    const r = await recoverFacilitatorGap(ADDR, CURSOR, {
      fetchSignatures: fakeRpc(history, 1000).fetchSignatures,
      parseBatch: async (sigs) => ({
        transactions: [], requested: sigs.length,
        unresolved: sigs.includes('s1') ? ['s1'] : [],
        undecodable: 0, recoveredFromArchive: 0,
      }),
      extract: () => null,
      persist: async () => 0,
      advanceCursor: async (_a, s) => { advanced.push(s); },
    }, { batchSize: 2 });

    // ordered = s4,s3,s2,s1. The walk freezes at the batch holding s1, then the
    // post-retry recompute extends the prefix to s2 — the last signature that
    // actually landed and is still contiguous with the cursor. It stops there.
    expect(advanced.at(-1)).toBe('s2');
    expect(r.cursorAdvanced).toBe(true);
    expect(r.complete).toBe(false);
    expect(advanced).not.toContain('s1'); // never past the hole
  });

  test('a CAPPED walk never advances, even per batch', async () => {
    // Capping stops the walk before it reaches the cursor, so the signatures in
    // hand are the TOP of the gap — not adjacent to the cursor. Advancing would
    // skip the hole underneath them.
    const history = ['s1', 's2', 's3', 's4', 's5', 's6', CURSOR];
    const advanced: string[] = [];
    const r = await recoverFacilitatorGap(ADDR, CURSOR, {
      fetchSignatures: fakeRpc(history, 2).fetchSignatures,
      parseBatch: async (sigs) => ({
        transactions: [], requested: sigs.length, unresolved: [], undecodable: 0, recoveredFromArchive: 0,
      }),
      extract: () => null,
      persist: async () => 0,
      advanceCursor: async (_a, s) => { advanced.push(s); },
    }, { pageSize: 2, maxSignatures: 2, batchSize: 1 });

    expect(r.capped).toBe(true);
    expect(advanced).toEqual([]);
    expect(r.cursorAdvanced).toBe(false);
  });
});

// Observed on the first real run (2026-09-10): 10 transient archive 429s across
// 2,656 signatures, the FIRST of them in batch 3 of ~107. Under the
// prefix rule that froze the cursor 50 signatures in and kept it frozen for the
// remaining ~2,600 — so the whole walk had to be redone. One flaky call must not
// cost the run its resumability when a retry would have resolved it.
describe('recoverFacilitatorGap retries unresolved signatures before giving up', () => {
  const ADDR = 'Faci1itator22222222222222222222222222222222';
  const history = ['s1', 's2', 's3', 's4', CURSOR];

  test('a transient miss that resolves on retry still completes and reaches the top', async () => {
    let seen = 0;
    const advanced: string[] = [];
    const r = await recoverFacilitatorGap(ADDR, CURSOR, {
      fetchSignatures: fakeRpc(history, 1000).fetchSignatures,
      parseBatch: async (sigs) => {
        seen++;
        // s4 (the oldest, ingested first) misses once, then succeeds on retry.
        const miss = seen === 1 && sigs.includes('s4');
        return {
          transactions: sigs.filter((x) => !(miss && x === 's4')).map((signature) => ({ signature }) as never),
          requested: sigs.length,
          unresolved: miss ? ['s4'] : [],
          undecodable: 0, recoveredFromArchive: 0,
        };
      },
      extract: (tx) => ({ tx_signature: (tx as { signature: string }).signature }) as never,
      persist: async (rows) => rows.length,
      advanceCursor: async (_a, s) => { advanced.push(s); },
    }, { batchSize: 2 });

    expect(r.unresolved).toBe(0);       // the retry cleared it
    expect(r.complete).toBe(true);
    expect(advanced.at(-1)).toBe('s1'); // cursor reached the top of the gap
  });

  test('the retry INGESTS what it recovers, it does not just clear the counter', async () => {
    let seen = 0;
    const persisted: string[] = [];
    await recoverFacilitatorGap(ADDR, CURSOR, {
      fetchSignatures: fakeRpc(history, 1000).fetchSignatures,
      parseBatch: async (sigs) => {
        seen++;
        const miss = seen === 1 && sigs.includes('s4');
        return {
          transactions: sigs.filter((x) => !(miss && x === 's4')).map((signature) => ({ signature }) as never),
          requested: sigs.length, unresolved: miss ? ['s4'] : [],
          undecodable: 0, recoveredFromArchive: 0,
        };
      },
      extract: (tx) => ({ tx_signature: (tx as { signature: string }).signature }) as never,
      persist: async (rows) => { persisted.push(...rows.map((x) => x.tx_signature)); return rows.length; },
      advanceCursor: async () => {},
    }, { batchSize: 2 });

    expect(persisted).toContain('s4');
  });

  test('a signature that fails BOTH times stays unresolved and blocks completion', async () => {
    const advanced: string[] = [];
    const r = await recoverFacilitatorGap(ADDR, CURSOR, {
      fetchSignatures: fakeRpc(history, 1000).fetchSignatures,
      parseBatch: async (sigs) => ({
        transactions: sigs.filter((x) => x !== 's4').map((signature) => ({ signature }) as never),
        requested: sigs.length,
        unresolved: sigs.includes('s4') ? ['s4'] : [],
        undecodable: 0, recoveredFromArchive: 0,
      }),
      extract: (tx) => ({ tx_signature: (tx as { signature: string }).signature }) as never,
      persist: async (rows) => rows.length,
      advanceCursor: async (_a, s) => { advanced.push(s); },
    }, { batchSize: 2 });

    expect(r.unresolved).toBe(1);
    expect(r.complete).toBe(false);
    expect(advanced).not.toContain('s1'); // never claims the top
  });
});

// Recovering receipts that never reach scoring changes nothing a user can see.
// The first live run ingested 2,222 rows and moved zero karma scores, because
// nothing marked their payers dirty — the same wiring wallet-scan has had all
// along (wallet-scan.ts:300).
describe('recoverFacilitatorGap marks recovered payers for rescoring', () => {
  const ADDR = 'Faci1itator22222222222222222222222222222222';
  const history = ['s1', 's2', 's3', 's4', CURSOR];

  function depsWithPayers(over: Partial<GapRecoveryDeps> = {}) {
    const dirty: string[][] = [];
    const base: GapRecoveryDeps = {
      fetchSignatures: fakeRpc(history, 1000).fetchSignatures,
      parseBatch: async (sigs) => ({
        transactions: sigs.map((signature) => ({ signature }) as never),
        requested: sigs.length, unresolved: [], undecodable: 0, recoveredFromArchive: 0,
      }),
      // Two distinct payers, alternating across the gap.
      extract: (tx) => {
        const sig = (tx as { signature: string }).signature;
        return { tx_signature: sig, wallet_address: sig === 's1' ? 'payerB' : 'payerA' } as never;
      },
      persist: async (rows) => rows.length,
      markDirty: async (addrs) => { dirty.push(addrs); },
      advanceCursor: async () => {},
      ...over,
    };
    return { base, dirty };
  }

  test('marks the distinct payers behind the recovered rows', async () => {
    const { base, dirty } = depsWithPayers();
    await recoverFacilitatorGap(ADDR, CURSOR, base, { batchSize: 10 });

    const all = new Set(dirty.flat());
    expect(all.has('payerA')).toBe(true);
    expect(all.has('payerB')).toBe(true);
  });

  test('deduplicates within a batch — one entry per payer, not one per row', async () => {
    const { base, dirty } = depsWithPayers();
    await recoverFacilitatorGap(ADDR, CURSOR, base, { batchSize: 10 });

    for (const batch of dirty) expect(batch.length).toBe(new Set(batch).size);
  });

  test('a dry run marks nothing', async () => {
    const { base, dirty } = depsWithPayers();
    await recoverFacilitatorGap(ADDR, CURSOR, base, { dryRun: true });
    expect(dirty).toEqual([]);
  });

  test('nothing extracted → nothing marked', async () => {
    const { base, dirty } = depsWithPayers({ extract: () => null });
    await recoverFacilitatorGap(ADDR, CURSOR, base, { batchSize: 10 });
    expect(dirty).toEqual([]);
  });
});

// Observed 2026-09-11: the retry pass cleared 115 main-loop misses down to 4,
// but the cursor still stopped at the FIRST main-loop miss — the prefix was
// computed during the walk and never revisited. 650 of 2,606 signatures were
// credited when nearly all of them had, in the end, resolved.
describe('recoverFacilitatorGap recomputes the prefix after retries', () => {
  const ADDR = 'Faci1itator22222222222222222222222222222222';
  const history = ['s1', 's2', 's3', 's4', 's5', 's6', CURSOR]; // ordered: s6..s1

  /** Misses `transient` on first sight only; misses `permanent` always. */
  function flaky(transient: string[], permanent: string[]) {
    const seen = new Set<string>();
    return async (sigs: string[]) => {
      const unresolved = sigs.filter((x) => {
        if (permanent.includes(x)) return true;
        if (transient.includes(x) && !seen.has(x)) { seen.add(x); return true; }
        return false;
      });
      return {
        transactions: sigs.filter((x) => !unresolved.includes(x)).map((signature) => ({ signature }) as never),
        requested: sigs.length, unresolved, undecodable: 0, recoveredFromArchive: 0,
      };
    };
  }

  test('the cursor ends just below the OLDEST still-missing signature, not the first transient one', async () => {
    // s6 (oldest, first batch) blips then recovers; s2 never resolves.
    const advanced: string[] = [];
    const r = await recoverFacilitatorGap(ADDR, CURSOR, {
      fetchSignatures: fakeRpc(history, 1000).fetchSignatures,
      parseBatch: flaky(['s6'], ['s2']),
      extract: (tx) => ({ tx_signature: (tx as { signature: string }).signature }) as never,
      persist: async (rows) => rows.length,
      advanceCursor: async (_a, s) => { advanced.push(s); },
    }, { batchSize: 2 });

    expect(r.unresolved).toBe(1);          // only s2 survives
    expect(r.complete).toBe(false);
    // ordered = s6,s5,s4,s3,s2,s1 → prefix ends at s3, the one before s2.
    expect(advanced.at(-1)).toBe('s3');
    expect(advanced).not.toContain('s1');  // never past the hole
  });

  test('every miss clearing on retry takes the cursor all the way to the top', async () => {
    const advanced: string[] = [];
    const r = await recoverFacilitatorGap(ADDR, CURSOR, {
      fetchSignatures: fakeRpc(history, 1000).fetchSignatures,
      parseBatch: flaky(['s6', 's4', 's2'], []),
      extract: (tx) => ({ tx_signature: (tx as { signature: string }).signature }) as never,
      persist: async (rows) => rows.length,
      advanceCursor: async (_a, s) => { advanced.push(s); },
    }, { batchSize: 2 });

    expect(r.complete).toBe(true);
    expect(advanced.at(-1)).toBe('s1'); // s1 is the newest of the gap
  });

  test('a capped walk still never advances, however the retries go', async () => {
    const advanced: string[] = [];
    const r = await recoverFacilitatorGap(ADDR, CURSOR, {
      fetchSignatures: fakeRpc(history, 2).fetchSignatures,
      parseBatch: flaky(['s6'], []),
      extract: () => null,
      persist: async () => 0,
      advanceCursor: async (_a, s) => { advanced.push(s); },
    }, { pageSize: 2, maxSignatures: 2, batchSize: 1 });

    expect(r.capped).toBe(true);
    expect(advanced).toEqual([]);
  });
});

// Run 34611182319: 83 minutes, 2,241 rows committed, cursor advanced ZERO, and
// the summary reported "inserted 0". Two causes — a miss in an early batch
// killed the prefix for the whole run (the end-of-run retry that would have
// cleared it never got to run), and the throw discarded the counts.
describe('recoverFacilitatorGap survives a mid-run crash', () => {
  const ADDR = 'Faci1itator22222222222222222222222222222222';
  const history = ['s1', 's2', 's3', 's4', 's5', 's6', CURSOR]; // ordered s6..s1

  test('a transient miss in the FIRST batch no longer poisons the whole run', async () => {
    // Retried immediately, so the prefix stays intact and the cursor keeps
    // climbing — instead of freezing at batch 1 for the next 80 minutes.
    const seen = new Set<string>();
    const advanced: string[] = [];
    const r = await recoverFacilitatorGap(ADDR, CURSOR, {
      fetchSignatures: fakeRpc(history, 1000).fetchSignatures,
      parseBatch: async (sigs) => {
        const miss = sigs.filter((x) => x === 's6' && !seen.has(x));
        miss.forEach((x) => seen.add(x));
        return {
          transactions: sigs.filter((x) => !miss.includes(x)).map((signature) => ({ signature }) as never),
          requested: sigs.length, unresolved: miss, undecodable: 0, recoveredFromArchive: 0,
        };
      },
      extract: (tx) => ({ tx_signature: (tx as { signature: string }).signature }) as never,
      persist: async (rows) => rows.length,
      advanceCursor: async (_a, s) => { advanced.push(s); },
    }, { batchSize: 2 });

    expect(r.unresolved).toBe(0);
    expect(r.complete).toBe(true);
    expect(advanced.at(-1)).toBe('s1');
  });

  test('an exception returns what landed instead of throwing it away', async () => {
    let n = 0;
    const advanced: string[] = [];
    const r = await recoverFacilitatorGap(ADDR, CURSOR, {
      fetchSignatures: fakeRpc(history, 1000).fetchSignatures,
      parseBatch: async (sigs) => {
        if (++n === 3) throw new TypeError('The socket connection was closed unexpectedly');
        return {
          transactions: sigs.map((signature) => ({ signature }) as never),
          requested: sigs.length, unresolved: [], undecodable: 0, recoveredFromArchive: 0,
        };
      },
      extract: (tx) => ({ tx_signature: (tx as { signature: string }).signature }) as never,
      persist: async (rows) => rows.length,
      advanceCursor: async (_a, s) => { advanced.push(s); },
    }, { batchSize: 2 });

    expect(r.error).toContain('socket connection');
    expect(r.inserted).toBe(4);        // two batches committed before the throw
    expect(r.complete).toBe(false);
    expect(advanced).toEqual(['s5', 's3']); // progress kept, not discarded
  });

  test('a crash NEVER advances the cursor past signatures it never processed', async () => {
    // The end-of-run prefix recompute must be bounded to what was actually
    // walked. Unbounded it would see "nothing missing" among the processed
    // batches and jump the cursor to the top of the gap, skipping the rest.
    let n = 0;
    const advanced: string[] = [];
    await recoverFacilitatorGap(ADDR, CURSOR, {
      fetchSignatures: fakeRpc(history, 1000).fetchSignatures,
      parseBatch: async (sigs) => {
        if (++n === 2) throw new Error('boom');
        return {
          transactions: sigs.map((signature) => ({ signature }) as never),
          requested: sigs.length, unresolved: [], undecodable: 0, recoveredFromArchive: 0,
        };
      },
      extract: (tx) => ({ tx_signature: (tx as { signature: string }).signature }) as never,
      persist: async (rows) => rows.length,
      advanceCursor: async (_a, s) => { advanced.push(s); },
    }, { batchSize: 2 });

    expect(advanced).toEqual(['s5']);      // only the batch that completed
    expect(advanced).not.toContain('s1');  // never the top
  });
});
