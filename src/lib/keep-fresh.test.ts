/// <reference types="bun-types" />
/**
 * Regression: 2026-08-17. keep-fresh ran its steps as one straight-line
 * `main()`, so the FIRST unguarded throw ended the process. Over 30 scheduled
 * runs, 6 died on a DB `57014` inside the Solana indexer (step 2) — and because
 * Arc ingest is step 2b, every one of those crashes ALSO skipped Arc, the
 * scoring drain and the freshness verdict. Arc's own try/catch protects it from
 * an Arc-RPC failure, never from an upstream one; measured effect was Arc
 * sitting 10.7h stale with a healthy RPC and nothing wrong on its side.
 *
 * The floor's whole purpose is surviving partial outages, so one broken step
 * must degrade to "that step failed", not "the run ended".
 */
import { describe, expect, test } from 'bun:test';
import { runKeepFresh, type KeepFreshDeps } from './keep-fresh';

const FRESH_TX = new Date(Date.now() - 60_000).toISOString();

/** All-green deps; each test overrides the one step it cares about. */
function makeDeps(over: Partial<KeepFreshDeps> = {}): { deps: KeepFreshDeps; ran: string[] } {
  const ran: string[] = [];
  const deps: KeepFreshDeps = {
    syncWebhook: async () => { ran.push('webhook'); return { matched: 1, active: 1, reEnabled: [], errors: [] }; },
    index: async () => { ran.push('index'); return { fetched: 1, inserted: 1, scored: 1, payshSignals: 0, operatorsScored: 0 }; },
    indexArc: async () => { ran.push('arc'); return { fetched: 2, inserted: 2 }; },
    drainOnce: async () => { ran.push('drain'); return { claimed: 0, scored: 0, skipped: 0, errors: [], remaining: 0, elapsedMs: 1 }; },
    readLastTxIso: async () => { ran.push('freshness'); return FRESH_TX; },
    now: () => Date.now(),
    ...over,
  };
  return { deps, ran };
}

describe('runKeepFresh isolates a failed step from the rest of the floor', () => {
  test('all steps green → ok, nothing recorded as failed', async () => {
    const { deps, ran } = makeDeps();
    const out = await runKeepFresh(deps);

    expect(out.ok).toBe(true);
    expect(out.failedSteps).toEqual([]);
    expect(ran).toEqual(['webhook', 'index', 'arc', 'drain', 'freshness']);
  });

  // The exact 2026-08-17 shape: Solana-side 57014 must not cost Arc its cycle.
  test('a crashed Solana indexer still lets Arc, the drain and the verdict run', async () => {
    const { deps, ran } = makeDeps({
      index: async () => {
        ran.push('index');
        throw { code: '57014', message: 'canceling statement due to statement timeout' };
      },
    });

    const out = await runKeepFresh(deps);

    expect(ran).toContain('arc');
    expect(ran).toContain('drain');
    expect(ran).toContain('freshness');
    // Still a failure — the Telegram page must keep firing…
    expect(out.ok).toBe(false);
    // …but naming the step, so the page says which half of the floor broke.
    expect(out.failedSteps).toEqual(['indexer']);
  });

  test('a wedged Arc RPC never blocks the Solana drain or the verdict', async () => {
    const { deps, ran } = makeDeps({
      indexArc: async () => { ran.push('arc'); throw new Error('arc rpc timeout'); },
    });

    const out = await runKeepFresh(deps);

    expect(ran).toContain('drain');
    expect(out.failedSteps).toEqual(['arc']);
    expect(out.ok).toBe(false);
  });

  // The webhook step was already non-fatal before this refactor, because it is
  // pure redundancy: the poller ingests with or without a live webhook.
  test('a webhook sync failure is recorded but never fails the run', async () => {
    const { deps } = makeDeps({ syncWebhook: async () => { throw new Error('helius 500'); } });

    const out = await runKeepFresh(deps);

    expect(out.ok).toBe(true);
    expect(out.failedSteps).toEqual([]);
    expect(out.webhookError).toContain('helius 500');
  });

  test('critical staleness fails the run even when every step succeeded', async () => {
    const { deps } = makeDeps({
      readLastTxIso: async () => new Date(Date.now() - 48 * 3600_000).toISOString(),
    });

    const out = await runKeepFresh(deps);

    expect(out.failedSteps).toEqual([]);
    expect(out.freshness?.severity).toBe('critical');
    expect(out.ok).toBe(false);
  });

  test('the drain loop stops as soon as the backlog is empty', async () => {
    let calls = 0;
    const { deps } = makeDeps({
      drainOnce: async () => {
        calls++;
        return calls === 1
          ? { claimed: 5, scored: 5, skipped: 0, errors: [], remaining: 3, elapsedMs: 1 }
          : { claimed: 3, scored: 3, skipped: 0, errors: [], remaining: 0, elapsedMs: 1 };
      },
    });

    const out = await runKeepFresh(deps, { drainBatches: 50 });

    expect(calls).toBe(2);
    expect(out.drained).toBe(8);
  });
});
