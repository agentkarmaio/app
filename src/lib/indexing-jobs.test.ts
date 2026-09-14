import { expect, test } from 'bun:test';
import { coverageOutcome, runManagedIndexingTask, type ManagedTaskStore } from './indexing-jobs';
import type { IndexingJob, ScanOutcome } from './indexing-runner';
import type { IndexingState } from '@/db/indexing-state';
const coverage = { complete: false, checked: 0, pending: 10, unresolved: 0 };
test('a first-window provider throttle is failed, not successful catch-up', () => {
  expect(
    coverageOutcome({ ...coverage, reason: 'rate_limited' }, 0).status,
  ).toBe('failed');
});
// Observed in keep-fresh run 34805594213: 30 facilitators checked, 895 rows
// landed, freshness "fresh" — and ONE throttled getSignaturesForAddress made the
// whole run 'failed' and paged, because `rpc_rate_limited` was listed
// unconditionally while its sibling `rate_limited` was gated on checked === 0.
test('one throttled call does not fail a run that checked targets and landed rows', () => {
  expect(
    coverageOutcome({ ...coverage, checked: 30, reason: 'rpc_rate_limited' }, 895).status,
  ).not.toBe('failed');
});
test('a throttle that checked nothing is still failed', () => {
  expect(
    coverageOutcome({ ...coverage, checked: 0, reason: 'rpc_rate_limited' }, 0).status,
  ).toBe('failed');
});
test('bounded completed progress stays visible without claiming full success', () => {
  expect(
    coverageOutcome({ ...coverage, checked: 5, reason: 'budget' }, 2).status,
  ).toBe('catching_up');
});
test('irreversible scope gaps are distinct from retriable parse failures', () => {
  const r = coverageOutcome(
    { ...coverage, complete: true, pending: 0, gaps: 1 },
    0,
  );
  expect(r.status).toBe('catching_up');
  expect(r.gapCount).toBe(1);
  expect(r.unresolvedCount).toBe(0);
});
test('empty configured targets are dormant while failed address reads are failed', () => {
  expect(coverageOutcome({ ...coverage, reason: 'empty_seed' }, 0).status).toBe(
    'dormant',
  );
  expect(
    coverageOutcome({ ...coverage, reason: 'address_failure' }, 0).status,
  ).toBe('failed');
});
test('a retained registry ledger is catch-up, not a failed run', () => {
  const r = coverageOutcome(
    {
      ...coverage,
      checked: 200,
      pending: 1312,
      unresolved: 1397,
      reason: 'retry_backlog',
    },
    93,
  );
  expect(r.status).toBe('catching_up');
  expect(r.errorCode).toBe('retry_backlog');
  expect(r.unresolvedCount).toBe(1397);
});
test('an on-chain registry read failure stays failed', () => {
  expect(
    coverageOutcome({ ...coverage, reason: 'registry_read_failure' }, 0).status,
  ).toBe('failed');
});

function managed(
  outcome: ScanOutcome,
  state: Partial<IndexingState> | null,
) {
  const job: IndexingJob = {
    chain: 'arc', path: 'transfers', intervalMs: 60_000, run: async () => outcome,
  };
  const store: ManagedTaskStore = {
    acquire: async () => (state ? (state as IndexingState) : null),
    renew: async () => true,
    finish: async () => true,
    release: async () => true,
    withContext: (_identity, fn) => fn(),
  };
  return runManagedIndexingTask(job, store);
}

const backlogged: ScanOutcome = {
  status: 'catching_up', errorCode: 'budget', checkpoint: '55909035',
  checkedCount: 0, insertedCount: 0, pendingCount: 5868483, gapCount: 0, unresolvedCount: 0,
};

test('a finished path whose cursor stood still while a backlog waited is reported stalled', async () => {
  const result = await managed(backlogged, {
    gaps_count: 0, checkpoint: '55909035', last_finished_at: '2026-09-12T19:18:00Z',
  });
  expect(result).toMatchObject({ stalled: true });
});

test('a path that has never finished cannot be judged stalled on its first run', async () => {
  // A checkpoint with no completed run behind it is not a baseline: only a
  // finished run proves where the cursor actually stood.
  const result = await managed(backlogged, {
    gaps_count: 0, checkpoint: '55909035', last_finished_at: null,
  });
  expect(result).toMatchObject({ stalled: false });
});

test('an advancing cursor clears the stall even when the backlog is still huge', async () => {
  const result = await managed(backlogged, {
    gaps_count: 0, checkpoint: '53629035', last_finished_at: '2026-09-12T13:35:00Z',
  });
  expect(result).toMatchObject({ stalled: false });
});

test('a lease held by another worker reports busy and never a stall verdict', async () => {
  const result = await managed(backlogged, null);
  expect(result).toEqual({ status: 'busy' });
});

test('retained gaps still survive a clean scan without inventing a stall', async () => {
  const result = await managed(
    { status: 'caught_up', checkpoint: '61777544', head: '61777544',
      checkedCount: 335, insertedCount: 0, pendingCount: 0, gapCount: 0, unresolvedCount: 0 },
    { gaps_count: 1, checkpoint: '61777544', last_finished_at: '2026-09-12T19:18:00Z' },
  );
  expect(result).toMatchObject({ status: 'catching_up', errorCode: 'archive_gap', gapCount: 1, stalled: false });
});
