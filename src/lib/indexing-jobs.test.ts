import { expect, spyOn, test } from 'bun:test';
import { coverageOutcome, registryScanReason, createIndexingJob, runManagedIndexingTask, type ManagedTaskStore } from './indexing-jobs';
import * as registry from '@/indexer/erc8004-registry';
import * as db from '@/db/client';
import * as mainnetTransfers from '@/indexer/arc-mainnet-transfers';
import * as mainnetScores from '@/scoring/arc-mainnet-persistence';
import { markIndexingLeaseLost, runWithIndexingContext } from '@/db/indexing-context';
import { indexingErrorCode } from './indexing-runner';
import type { IndexingJob, ScanOutcome } from './indexing-runner';
import type { IndexingState } from '@/db/indexing-state';
const coverage = { complete: false, checked: 0, pending: 10, unresolved: 0 };

test.each(['celo', 'arc-mainnet'] as const)('%s managed registry job uses incremental discovery with chain-bound persistence', async chain => {
  const get = spyOn(db, 'getRegistryCursorTip').mockResolvedValue(7);
  const set = spyOn(db, 'setRegistryCursorTip').mockResolvedValue(undefined);
  const scan = spyOn(registry, 'runIncrementalRegistryScan').mockImplementation(async (config, agents, feedback, getCursor, setCursor, opts) => {
    expect(config.chain).toBe(chain);
    expect(agents).toBe(db.upsertErc8004Agents);
    expect(feedback).toBe(db.upsertErc8004Feedback);
    expect(opts?.rescanWindow).toBe(37);
    expect(opts?.signal).toBe(signal);
    expect(await getCursor(config.chain)).toBe(7);
    await setCursor(config.chain, 9);
    return { chain, tip: 9, agentsScanned: 2, agentsPersisted: 2, feedbackScanned: 0, feedbackPersisted: 0, errors: 0, registrationUnreachable: 0 };
  });
  const signal = new AbortController().signal;
  try {
    const job = createIndexingJob(chain, 'registry', { rescanWindow: 37 });
    expect(job.timeoutMs).toBe(1_200_000);
    expect(await job.run(signal)).toMatchObject({ status: 'caught_up', checkpoint: '9', head: '9', checkedCount: 2, insertedCount: 2 });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(chain);
    expect(set).toHaveBeenCalledWith(chain, 9);
  } finally { scan.mockRestore(); get.mockRestore(); set.mockRestore(); }
});

test.each(['celo', 'arc-mainnet'] as const)('%s partial registry run must not publish the discovered tip as its checkpoint', async chain => {
  const scan = spyOn(registry, 'runIncrementalRegistryScan').mockResolvedValue({
    chain, tip: 9, agentsScanned: 1, agentsPersisted: 1, feedbackScanned: 0, feedbackPersisted: 0, errors: 1, registrationUnreachable: 0,
  });
  try {
    const outcome = await createIndexingJob(chain, 'registry').run(new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'catching_up', errorCode: 'retry_backlog', head: '9', unresolvedCount: 1 });
    expect(outcome.checkpoint).toBeUndefined();
  } finally { scan.mockRestore(); }
});
test.each([true, false])('mainnet transfer ticks refresh persisted ranks even with no inserts (cycle complete=%s)', async complete => {
  const scan = spyOn(mainnetTransfers, 'runArcMainnetTransfersIndexer').mockResolvedValue({
    fetched: 0, inserted: 0, cursors: new Map(),
    coverage: { complete: true, checked: 1, pending: 0, unresolved: 0, checkpoint: '10', head: '10' },
  });
  const refresh = spyOn(mainnetScores, 'refreshArcMainnetScores').mockResolvedValue({ scored: 1, complete, cursor: complete ? '' : 'address' });
  const signal = new AbortController().signal;
  try {
    const outcome = await createIndexingJob('arc-mainnet', 'transfers').run(signal);
    expect(refresh).toHaveBeenCalledWith({ signal });
    expect(outcome).toMatchObject({ status: complete ? 'caught_up' : 'catching_up', insertedCount: 0, checkpoint: '10', checkedCount: 2 });
    if (!complete) expect(outcome).toMatchObject({ errorCode: 'score_refresh_pending', pendingCount: 1 });
  } finally { scan.mockRestore(); refresh.mockRestore(); }
});
test('RPC failure still refreshes DB-only decay and preserves the original ingestion error', async () => {
  const failure = new Error('rpc_unavailable');
  const scan = spyOn(mainnetTransfers, 'runArcMainnetTransfersIndexer').mockRejectedValue(failure);
  const refresh = spyOn(mainnetScores, 'refreshArcMainnetScores').mockResolvedValue({ scored: 1, complete: true, cursor: '' });
  const signal = new AbortController().signal;
  try {
    await expect(createIndexingJob('arc-mainnet', 'transfers').run(signal)).rejects.toBe(failure);
    expect(refresh).toHaveBeenCalledWith({ signal });
  } finally { scan.mockRestore(); refresh.mockRestore(); }
});
test('simultaneous ingestion and scoring errors remain available with ingestion failure classification', async () => {
  const ingestionError = new Error('rpc_rate_limited');
  const scoreError = new Error('score persistence unavailable');
  const scan = spyOn(mainnetTransfers, 'runArcMainnetTransfersIndexer').mockRejectedValue(ingestionError);
  const refresh = spyOn(mainnetScores, 'refreshArcMainnetScores').mockRejectedValue(scoreError);
  try {
    const failure = await createIndexingJob('arc-mainnet', 'transfers').run(new AbortController().signal).catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([ingestionError, scoreError]);
    expect(failure.cause).toBe(ingestionError);
    expect(indexingErrorCode(failure)).toBe('rpc_rate_limited');
  } finally { scan.mockRestore(); refresh.mockRestore(); }
});
test('a scoring failure after successful ingestion fails the whole managed job', async () => {
  const scan = spyOn(mainnetTransfers, 'runArcMainnetTransfersIndexer').mockResolvedValue({ fetched: 0, inserted: 0, cursors: new Map(),
    coverage: { complete: true, checked: 1, pending: 0, unresolved: 0, checkpoint: '10', head: '10' } });
  const failure = new Error('score persistence unavailable');
  const refresh = spyOn(mainnetScores, 'refreshArcMainnetScores').mockRejectedValue(failure);
  try {
    await expect(createIndexingJob('arc-mainnet', 'transfers').run(new AbortController().signal)).rejects.toBe(failure);
  } finally { scan.mockRestore(); refresh.mockRestore(); }
});
test.each(['abort', 'lease_lost'] as const)('%s during ingestion prevents the decay phase from starting', async mode => {
  const controller = new AbortController();
  const scan = spyOn(mainnetTransfers, 'runArcMainnetTransfersIndexer').mockImplementation(async () => {
    if (mode === 'abort') controller.abort(); else markIndexingLeaseLost();
    throw new Error('rpc_unavailable');
  });
  const refresh = spyOn(mainnetScores, 'refreshArcMainnetScores').mockResolvedValue({ scored: 1, complete: true, cursor: '' });
  try {
    await expect(runWithIndexingContext({ chain: 'arc-mainnet', path: 'transfers', owner: 'test-owner', signal: controller.signal },
      () => createIndexingJob('arc-mainnet', 'transfers').run(controller.signal))).rejects.toThrow();
    expect(refresh).not.toHaveBeenCalled();
  } finally { scan.mockRestore(); refresh.mockRestore(); }
});
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

// A population scan's health is a ratio, not a boolean. stellar/registry went
// `failed` on 1 unreadable agent out of 68 on 2026-09-17 — a re-run seconds
// later returned zero errors — and the public card called the whole chain dead.
test('a membership scan that read its population is backlog, however many members failed', () => {
  expect(registryScanReason(68, 1, 0)).toBe('retry_backlog');
  expect(coverageOutcome({ complete: true, checked: 68, pending: 0, unresolved: 1,
    reason: registryScanReason(68, 1, 0) }, 67).status).toBe('catching_up');
});
test('a membership scan that read nothing while work waited is the fault worth paging', () => {
  expect(registryScanReason(0, 1, 0)).toBe('registry_read_failure');
  expect(coverageOutcome({ complete: false, checked: 0, pending: 0, unresolved: 1,
    reason: registryScanReason(0, 1, 0) }, 0).status).toBe('failed');
  expect(registryScanReason(0, 0, 40)).toBe('registry_read_failure');
});
test('a clean membership sweep carries no reason at all', () => {
  expect(registryScanReason(68, 0, 0)).toBeUndefined();
  expect(coverageOutcome({ complete: true, checked: 68, pending: 0, unresolved: 0,
    reason: registryScanReason(68, 0, 0) }, 68).status).toBe('caught_up');
});
// An empty population is dormant, not broken: nothing was read because there
// was nothing to read.
test('an empty population is not a read failure', () => {
  expect(registryScanReason(0, 0, 0)).toBeUndefined();
});


test.each(['escrow', 'transfers', 'registry'] as const)('retired Arc testnet refuses the %s job before any dependencies run', path => {
  expect(() => createIndexingJob('arc', path)).toThrow('arc_testnet_retired');
});
