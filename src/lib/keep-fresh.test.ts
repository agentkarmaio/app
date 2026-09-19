/// <reference types="bun-types" />
/**
 * Two regressions, nine years of alert-design apart in spirit and four weeks in
 * practice.
 *
 * 2026-08-17 — keep-fresh ran its steps as one straight-line `main()`, so the
 * FIRST unguarded throw ended the process. Over 30 scheduled runs, 6 died on a
 * DB `57014` inside the Solana indexer, and each one also skipped every step
 * after it. One broken step must degrade to "that step failed", never to "the
 * run ended".
 *
 * 2026-09-11 → 09-19 — 25 of 35 scheduled runs paged. 24 of those logged
 * `freshness: fresh`, and 19 had ingested receipts and scored every wallet in
 * the same run; meanwhile one run that did NO work (lease held elsewhere,
 * nothing indexed, data 5 h old) exited 0 in silence. The exit code tracked
 * internal step accounting rather than whether the floor could do its job, so
 * it was simultaneously noisy and blind.
 *
 * The bottom `describe` replays the five real runs from that window that a
 * human should have been woken for, and the two shapes that flooded the phone.
 */
import { describe, expect, test } from 'bun:test';
import { runKeepFresh, type IndexerStepResult, type KeepFreshDeps } from './keep-fresh';
import type { RescoreResult } from '@/scripts/rescore-dirty';

const FRESH_TX = new Date(Date.now() - 60_000).toISOString();
const WARNING_TX = new Date(Date.now() - 5 * 3600_000).toISOString();
const CRITICAL_TX = new Date(Date.now() - 48 * 3600_000).toISOString();

function summary(over: Partial<IndexerStepResult['summary'] & object> = {}) {
  return { fetched: 1, inserted: 1, queued: 1, payshSignals: 0, operatorsScored: 0, unresolved: 0, ...over };
}

/** A scan that ran to the end and reported a clean, complete result. */
function completedScan(over: Partial<IndexerStepResult> = {}): IndexerStepResult {
  return { summary: summary(), status: 'caught_up', stalled: false, completed: true, ...over };
}

function drain(over: Partial<RescoreResult> = {}): RescoreResult {
  return {
    claimed: 0, scored: 0, skipped: 0, errors: [], remaining: 0, elapsedMs: 1,
    attestationsUnavailable: false, ...over,
  };
}

/** All-green deps; each test overrides the one step it cares about. */
function makeDeps(over: Partial<KeepFreshDeps> = {}): { deps: KeepFreshDeps; ran: string[] } {
  const ran: string[] = [];
  const deps: KeepFreshDeps = {
    syncWebhook: async () => { ran.push('webhook'); return { matched: 1, active: 1, created: [], reEnabled: [], errors: [] }; },
    index: async () => { ran.push('index'); return completedScan(); },
    indexArc: async () => { ran.push('arc'); return { fetched: 0, inserted: 0 }; },
    drainOnce: async () => { ran.push('drain'); return drain(); },
    readLastTxIso: async () => { ran.push('freshness'); return FRESH_TX; },
    readIndexerLastFinishedIso: async () => new Date(Date.now() - 60_000).toISOString(),
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
    expect(out.pageReasons).toEqual([]);
    expect(ran).toEqual(['webhook', 'index', 'arc', 'drain', 'freshness']);
  });

  // The exact 2026-08-17 shape: a Solana-side 57014 must not cost the rest.
  test('a crashed Solana indexer still lets the drain and the verdict run', async () => {
    const { deps, ran } = makeDeps({
      index: async () => {
        ran.push('index');
        throw { code: '57014', message: 'canceling statement due to statement timeout' };
      },
    });

    const out = await runKeepFresh(deps);

    expect(ran).toContain('drain');
    expect(ran).toContain('freshness');
    expect(out.failedSteps).toEqual(['indexer']);
    // A step that THREW is infrastructure, not classification — it always pages.
    expect(out.ok).toBe(false);
    expect(out.pageReasons.join(' ')).toContain('step(s) threw');
  });

  // The webhook step is pure redundancy: the poller ingests without it.
  test('a webhook sync failure is recorded but never fails the run', async () => {
    const { deps } = makeDeps({ syncWebhook: async () => { throw new Error('helius 500'); } });

    const out = await runKeepFresh(deps);

    expect(out.ok).toBe(true);
    expect(out.failedSteps).toEqual([]);
    expect(out.webhookError).toContain('helius 500');
  });

  test('the drain loop stops as soon as the backlog is empty', async () => {
    let calls = 0;
    const { deps } = makeDeps({
      drainOnce: async () => {
        calls++;
        return calls === 1
          ? drain({ claimed: 5, scored: 5, remaining: 3 })
          : drain({ claimed: 3, scored: 3, remaining: 0 });
      },
    });

    const out = await runKeepFresh(deps, { drainBatches: 50 });

    expect(calls).toBe(2);
    expect(out.drained).toBe(8);
  });
});

describe('a completed scan reporting imperfect coverage is disclosed, not paged', () => {
  // 13 of the 25 pages in the window were this: ONE signature out of 100 that
  // the archive endpoint answered 429 for. All three sampled signatures were
  // verified present on chain the next day; nothing was lost, and the run had
  // ingested and scored everything else.
  test('unserved signatures no longer fail the run', async () => {
    const { deps } = makeDeps({
      index: async () => completedScan({
        summary: summary({ fetched: 979, inserted: 567, queued: 96, unresolved: 1 }),
        status: 'catching_up',
        errorCode: 'scan_partial',
      }),
    });

    const out = await runKeepFresh(deps);

    expect(out.ok).toBe(true);
    expect(out.indexer?.unresolved).toBe(1);
    // Still visible — disclosed on the health surface and named in the verdict.
    expect(out.indexerDegraded).toBe('scan_partial');
  });

  test('catching_up with everything ingested is ok', async () => {
    const { deps } = makeDeps({
      index: async () => completedScan({ status: 'catching_up', errorCode: 'archive_gap' }),
    });
    const out = await runKeepFresh(deps);
    expect(out.ok).toBe(true);
    expect(out.indexerDegraded).toBe('archive_gap');
  });

  // Bursty x402 volume means a 5 h old receipt can be a quiet market. What
  // decides is whether the scan ran, not how old the newest row is.
  test('warning-level freshness after a completed scan is ok', async () => {
    const { deps } = makeDeps({ readLastTxIso: async () => WARNING_TX });
    const out = await runKeepFresh(deps);
    expect(out.freshness?.severity).toBe('warning');
    expect(out.ok).toBe(true);
  });
});

describe('the floor pages when it could not do its job', () => {
  test('a scan that started and did not complete pages', async () => {
    const { deps } = makeDeps({
      index: async () => ({ summary: null, status: 'failed', errorCode: 'scan_timeout', stalled: false, completed: false }),
    });

    const out = await runKeepFresh(deps);

    expect(out.ok).toBe(false);
    expect(out.pageReasons.join(' ')).toContain('scan_timeout');
    // It threw nothing, so this is not a "failed step" — the run is still whole.
    expect(out.failedSteps).toEqual([]);
  });

  test('lease_lost pages even though another owner may have finished the work', async () => {
    const { deps } = makeDeps({
      index: async () => ({ summary: null, status: 'lease_lost', errorCode: 'lease_lost', stalled: false, completed: false }),
    });
    const out = await runKeepFresh(deps);
    expect(out.pageReasons.join(' ')).toContain('lease_lost');
    expect(out.ok).toBe(false);
  });

  // 2026-09-15 11:27 (run 34963343773): busy lease, nothing indexed, data 5 h
  // old — and it exited 0. This is the page that did not exist.
  test('a busy lease pages when nobody has finished a scan recently', async () => {
    const { deps } = makeDeps({
      index: async () => ({ summary: null, status: 'busy', stalled: false, completed: false }),
      readLastTxIso: async () => WARNING_TX,
      readIndexerLastFinishedIso: async () => new Date(Date.now() - 6 * 3600_000).toISOString(),
    });

    const out = await runKeepFresh(deps);

    expect(out.ok).toBe(false);
    expect(out.pageReasons.join(' ')).toContain('lease busy');
  });

  // …but deferring to a worker that IS delivering is the design, not a fault.
  test('a busy lease with a recent finished scan stays quiet', async () => {
    const { deps } = makeDeps({
      index: async () => ({ summary: null, status: 'busy', stalled: false, completed: false }),
      readIndexerLastFinishedIso: async () => new Date(Date.now() - 10 * 60_000).toISOString(),
    });

    const out = await runKeepFresh(deps);

    expect(out.ok).toBe(true);
    expect(out.indexerDegraded).toBe('busy');
  });

  test('a busy lease that has never finished a scan pages', async () => {
    const { deps } = makeDeps({
      index: async () => ({ summary: null, status: 'busy', stalled: false, completed: false }),
      readIndexerLastFinishedIso: async () => null,
    });
    expect((await runKeepFresh(deps)).ok).toBe(false);
  });

  test('critical staleness pages even when every step succeeded', async () => {
    const { deps } = makeDeps({ readLastTxIso: async () => CRITICAL_TX });
    const out = await runKeepFresh(deps);
    expect(out.freshness?.severity).toBe('critical');
    expect(out.failedSteps).toEqual([]);
    expect(out.ok).toBe(false);
  });

  // `severity: 'unknown'` is a real value (no row at all) and only 'critical'
  // was ever checked, so an empty transactions table read as healthy.
  test('a freshness read that finds no transactions at all pages', async () => {
    const { deps } = makeDeps({ readLastTxIso: async () => null });
    const out = await runKeepFresh(deps);
    expect(out.freshness?.severity).toBe('unknown');
    expect(out.ok).toBe(false);
  });

  test('an unreadable freshness read pages', async () => {
    const { deps } = makeDeps({ readLastTxIso: async () => { throw new Error('db down'); } });
    const out = await runKeepFresh(deps);
    expect(out.freshness).toBeNull();
    expect(out.ok).toBe(false);
  });

  // `drainOnce` collects per-wallet failures instead of throwing, so a scoring
  // backlog could fail on every wallet forever without anything noticing.
  test('a drain that claims work and scores none pages', async () => {
    const { deps } = makeDeps({
      drainOnce: async () => drain({ claimed: 4, scored: 0, remaining: 4, errors: [{ address: 'w', message: 'boom' }] }),
    });

    const out = await runKeepFresh(deps, { drainBatches: 1 });

    expect(out.ok).toBe(false);
    expect(out.pageReasons.join(' ')).toContain('scored none');
  });

  test('a drain with some failures but real progress is disclosed, not paged', async () => {
    const { deps } = makeDeps({
      drainOnce: async () => drain({ claimed: 4, scored: 3, remaining: 0, errors: [{ address: 'w', message: 'boom' }] }),
    });
    const out = await runKeepFresh(deps, { drainBatches: 1 });
    expect(out.ok).toBe(true);
    expect(out.drainErrors).toBe(1);
  });

  test('attestation unavailability is carried out of the drain', async () => {
    const { deps } = makeDeps({
      drainOnce: async () => drain({ claimed: 2, scored: 0, skipped: 2, remaining: 2, attestationsUnavailable: true }),
    });
    const out = await runKeepFresh(deps, { drainBatches: 1 });
    expect(out.attestationsUnavailable).toBe(true);
  });
});

describe('completing is not the same as succeeding', () => {
  // `coverageOutcome` returns `failed` when a throttle checked ZERO targets, and
  // for all_absent / rpc_unavailable / address_failure. runIndexer returns
  // normally in those cases, so `completed` alone would wave them through.
  test('a scan that returned with status failed still pages', async () => {
    const { deps } = makeDeps({
      index: async () => completedScan({
        summary: summary({ fetched: 0, inserted: 0, queued: 0 }),
        status: 'failed',
        errorCode: 'rpc_rate_limited',
      }),
    });

    const out = await runKeepFresh(deps);

    expect(out.ok).toBe(false);
    expect(out.pageReasons.join(' ')).toContain('rpc_rate_limited');
  });

  test('a dormant path (nothing to scan) is not a failure', async () => {
    const { deps } = makeDeps({
      index: async () => completedScan({ status: 'dormant', errorCode: 'empty_seed' }),
    });
    expect((await runKeepFresh(deps)).ok).toBe(true);
  });
});
