import { expect, test } from 'bun:test';
import {
  executeIndexingJob,
  indexingErrorCode,
  releaseHeldIndexingLeases,
  type LeaseDependencies,
  type IndexingJob,
} from './indexing-runner';
test('mainnet admission failures retain actionable safe classifications', () => {
  expect(indexingErrorCode(Error('rpc_authentication_failed'))).toBe('rpc_authentication_failed');
  expect(indexingErrorCode(Error('arc_mainnet_chain_mismatch'))).toBe('rpc_chain_mismatch');
  expect(indexingErrorCode(Error('arc_mainnet_rpc_missing'))).toBe('configuration_missing');
  expect(indexingErrorCode(Error('arc_mainnet_rpc_invalid'))).toBe('configuration_invalid');
});

test('structured provider errors retain their actionable classification', () => {
  expect(indexingErrorCode({ code: '57014', message: 'canceling statement due to statement timeout' })).toBe('rpc_unavailable');
  expect(indexingErrorCode({ code: 'PGRST301', message: 'JWT expired' })).toBe('rpc_authentication_failed');
  expect(indexingErrorCode({ code: '429', message: 'rate limit exceeded' })).toBe('rpc_rate_limited');
});

test('settlement history configuration faults have actionable bounded codes', () => {
  expect(indexingErrorCode(Error('arc_mainnet_walk_start_missing'))).toBe('configuration_missing');
  expect(indexingErrorCode(Error('arc_mainnet_walk_cursor_invalid'))).toBe('configuration_invalid');
  expect(indexingErrorCode(Error('arc_mainnet_walk_invalid'))).toBe('configuration_invalid');
  expect(indexingErrorCode(Error('arc_mainnet_seed_cursor_invalid'))).toBe('configuration_invalid');
  expect(indexingErrorCode(Error('arc_mainnet_walk_stats_invalid'))).toBe('configuration_invalid');
  expect(indexingErrorCode(Error('arc_mainnet_walk_wallet_invalid'))).toBe('configuration_invalid');
  expect(indexingErrorCode(Error('arc_mainnet_walk_head_behind'))).toBe('head_behind_cursor');
});
const job: IndexingJob = {
  chain: 'arc',
  path: 'escrow',
  intervalMs: 300000,
  run: async () => ({
    status: 'caught_up',
    insertedCount: 0,
    checkedCount: 10,
    pendingCount: 0,
  }),
};
function deps(over: Partial<LeaseDependencies> = {}) {
  const finishes: unknown[] = [];
  const releases: unknown[] = [];
  return {
    finishes,
    releases,
    value: {
      acquire: async () => true,
      renew: async () => true,
      finish: async (v) => {
        finishes.push(v);
        return true;
      },
      release: async (v) => {
        releases.push(v);
        return true;
      },
      withContext: async (_i, fn) => fn(),
      ...over,
    } satisfies LeaseDependencies,
  };
}
test('busy job never runs or finishes another owners lease', async () => {
  let ran = false;
  const d = deps({ acquire: async () => false });
  const r = await executeIndexingJob(
    {
      ...job,
      run: async () => {
        ran = true;
        return { status: 'caught_up' };
      },
    },
    d.value,
  );
  expect(r.status).toBe('busy');
  expect(ran).toBe(false);
  expect(d.finishes).toEqual([]);
});
test('zero inserts can be a real completed scan', async () => {
  const d = deps();
  const r = await executeIndexingJob(job, d.value);
  expect(r.status).toBe('caught_up');
  expect(d.finishes).toHaveLength(1);
});
test('mainnet score refresh backlog retains its stable classification through lease completion', async () => {
  const d = deps();
  const outcome = { status: 'catching_up' as const, errorCode: 'score_refresh_pending',
    checkedCount: 200, pendingCount: 1, checkpoint: '100', head: '100' };
  const result = await executeIndexingJob({ ...job, chain: 'arc-mainnet', path: 'transfers',
    run: async () => outcome }, d.value);
  expect(result).toEqual(outcome);
  expect(d.finishes).toHaveLength(1);
  expect(d.finishes[0]).toMatchObject({ ...outcome, chain: 'arc-mainnet', path: 'transfers' });
});
test('failure is recorded with safe error code, no provider key', async () => {
  const d = deps();
  const r = await executeIndexingJob(
    {
      ...job,
      run: async () => {
        throw Error('fetch failed https://secret/?key=TOPSECRET');
      },
    },
    d.value,
  );
  expect(r.status).toBe('failed');
  expect(JSON.stringify(d.finishes)).not.toContain('TOPSECRET');
});
test('expired ownership cannot publish successful completion', async () => {
  const d = deps({ finish: async () => false });
  expect((await executeIndexingJob(job, d.value)).status).toBe('lease_lost');
});
// `finish_indexing_run` clears ownership itself, so releasing after it would be
// a second write that could steal a lease a later run already holds.
test('a completed run does not also release', async () => {
  const d = deps();
  await executeIndexingJob(job, d.value);
  expect(d.releases).toEqual([]);
});
test('a rejected finish releases the orphaned lease', async () => {
  const d = deps({ finish: async () => false });
  await executeIndexingJob(job, d.value);
  expect(d.releases).toHaveLength(1);
  expect(d.releases[0]).toMatchObject({ chain: 'arc', path: 'escrow' });
});
test('a lost renewal releases the orphaned lease', async () => {
  const d = deps({ renew: async () => false });
  await executeIndexingJob(
    { ...job, run: async () => new Promise(() => {}) },
    d.value,
    { renewMs: 5, timeoutMs: 100 },
  );
  expect(d.releases).toHaveLength(1);
  expect(d.releases[0]).toMatchObject({ chain: 'arc', path: 'escrow' });
});
// A SIGTERM'd container is the common orphan source: the run is still in
// flight, so only an out-of-band release can hand the lease back.
test('shutdown releases every lease still in flight', async () => {
  const d = deps();
  let unblock = () => {};
  const running = executeIndexingJob(
    { ...job, run: () => new Promise((resolve) => { unblock = () => resolve({ status: 'caught_up' }); }) },
    d.value,
    { timeoutMs: 5_000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(await releaseHeldIndexingLeases()).toBe(1);
  expect(d.releases).toHaveLength(1);
  expect(d.releases[0]).toMatchObject({ chain: 'arc', path: 'escrow' });
  unblock();
  await running;
  // The run owns no lease after finishing, so a later shutdown releases nothing.
  expect(await releaseHeldIndexingLeases()).toBe(0);
});
test('renewal failure aborts running work and never claims success', async () => {
  let aborted = false;
  const d = deps({ renew: async () => false });
  const r = await executeIndexingJob(
    {
      ...job,
      run: async (signal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          ),
        );
        return { status: 'caught_up' };
      },
    },
    d.value,
    { renewMs: 5, timeoutMs: 100 },
  );
  expect(aborted).toBe(true);
  expect(r.status).toBe('lease_lost');
});
test('deadline fences work that ignores cancellation', async () => {
  const d = deps();
  const r = await executeIndexingJob(
    { ...job, run: async () => new Promise(() => {}) },
    d.value,
    { timeoutMs: 5 },
  );
  expect(r.status).toBe('failed');
  expect(r.errorCode).toBe('scan_timeout');
});
