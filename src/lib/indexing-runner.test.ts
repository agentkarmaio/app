import { expect, test } from 'bun:test';
import {
  executeIndexingJob,
  type LeaseDependencies,
  type IndexingJob,
} from './indexing-runner';
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
  return {
    finishes,
    value: {
      acquire: async () => true,
      renew: async () => true,
      finish: async (v) => {
        finishes.push(v);
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
