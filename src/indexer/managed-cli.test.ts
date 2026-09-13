import { expect, test } from 'bun:test';
import { runIndexerCli, type ManagedCliDependencies } from './managed-cli';
import type { IndexingJob } from '@/lib/indexing-runner';

function management(overrides: Partial<ManagedCliDependencies> = {}): ManagedCliDependencies {
  return {
    createJob: (chain, path) => ({ chain, path, intervalMs: 1000, run: async () => ({ status: 'caught_up' }) }),
    execute: async (job) => job.run(new AbortController().signal),
    ...overrides,
  };
}
const summarize = () => ({ status: 'caught_up' as const, checkedCount: 4 });

test('dry-run never loads or touches lease/health dependencies', async () => {
  const result = await runIndexerCli({
    chain: 'celo', path: 'payments', dryRun: true, run: async (signal) => { expect(signal).toBeUndefined(); return { rows: 4 }; }, summarize,
  }, async () => { throw Error('health write forbidden'); });
  expect(result).toEqual({ status: 'dry_run', exitCode: 0, result: { rows: 4 } });
});
test('busy live command does not call an unleased fallback or fabricate a result', async () => {
  let calls = 0;
  const result = await runIndexerCli({ chain: 'arc', path: 'transfers', run: async () => { calls++; return 7; }, summarize },
    async () => management({ execute: async () => ({ status: 'busy' }) }));
  expect(calls).toBe(0); expect(result).toEqual({ status: 'busy', exitCode: 2 });
});
test('live command keeps the exact raw result and receives the leased abort signal', async () => {
  const controller = new AbortController(); let jobSeen: IndexingJob | undefined;
  const raw = { fetched: 9, cursors: new Map([['x', '42']]) };
  const result = await runIndexerCli({ chain: 'stellar', path: 'transfers', run: async (signal) => { expect(signal).toBe(controller.signal); return raw; }, summarize },
    async () => management({ execute: async (job) => { jobSeen = job; return job.run(controller.signal); } }));
  expect(jobSeen?.chain).toBe('stellar'); expect(jobSeen?.path).toBe('transfers');
  expect(result.result).toBe(raw); expect(result.exitCode).toBe(0);
});
test('failed managed verdict produces nonzero exit even when a raw result was captured', async () => {
  const result = await runIndexerCli({ chain: 'celo', path: 'registry', run: async () => ({ errors: 1 }), summarize: () => ({ status: 'failed', errorCode: 'scan_partial' }) }, async () => management());
  expect(result.result).toEqual({ errors: 1 }); expect(result.exitCode).toBe(1);
});
test('lost lease cannot turn a finished callback into a successful CLI exit', async () => {
  const result = await runIndexerCli({ chain: 'solana', path: 'payments', run: async () => 4, summarize }, async () => management({
    execute: async (job) => { await job.run(new AbortController().signal); return { status: 'lease_lost' }; },
  }));
  expect(result.status).toBe('lease_lost'); expect(result.exitCode).toBe(1);
});
