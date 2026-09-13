import { describe, expect, test } from 'bun:test';
import { activityStatus, parseActivityStats, parseActivityHealth, startActivityPoll, type ActivityStats } from './live-flow-state';
import type { IndexingHealth } from '@/lib/indexing-health';

const stats: ActivityStats = { totalTransactions: 42, totalAgents: 17 };
const health = (status: IndexingHealth['status']): IndexingHealth => ({ status, checkedAt: '2026-09-12T12:00:00Z', chains: [] });

describe('activity freshness', () => {
  test('a successful HTTP response is not proof of current chain coverage', () => {
    expect(activityStatus(stats, health('catching_up'), false, false)).toBe('Catching up');
    expect(activityStatus(stats, health('unknown'), false, false)).toBe('Coverage unverified');
    expect(activityStatus(stats, health('current'), false, false)).toBe('Up to date');
  });
  test('either request failing or a cached counter fallback remains visibly delayed', () => {
    expect(activityStatus(stats, health('current'), true, false)).toBe('Updates delayed');
    expect(activityStatus(stats, health('current'), false, true)).toBe('Updates delayed');
    expect(activityStatus({ ...stats, freshness: { stale: true, transactionsUpdatedAt: null, agentsUpdatedAt: null } }, health('current'), false, false)).toBe('Updates delayed');
  });
  test('rejects malformed counters rather than replacing saved counts with zero', () => {
    expect(() => parseActivityStats({ error: 'not available' })).toThrow();
    expect(() => parseActivityStats({ totalTransactions: null, totalAgents: 17 })).toThrow();
    expect(() => parseActivityStats({ totalTransactions: -1, totalAgents: 17 })).toThrow();
    expect(parseActivityStats({ totalTransactions: 0, totalAgents: 0 })).toEqual({ totalTransactions: 0, totalAgents: 0 });
  });
});

describe('activity polling', () => {
  test('never overlaps requests and suppresses a late response after cleanup', async () => {
    let calls = 0;
    let resolve!: (value: number) => void;
    let signal!: AbortSignal;
    const values: number[] = [];
    const stop = startActivityPoll({
      load: (s) => { calls++; signal = s; return new Promise<number>((r) => { resolve = r; }); },
      receive: (value) => { values.push(value); }, failed: () => {}, intervalMs: 1, timeoutMs: 1000,
    });
    await new Promise((r) => setTimeout(r, 8));
    expect(calls).toBe(1);
    stop();
    expect(signal.aborted).toBe(true);
    resolve(99);
    await new Promise((r) => setTimeout(r, 4));
    expect(values).toEqual([]);
    expect(calls).toBe(1);
  });

  test('a timed-out request signals failure while preserving the last received value', async () => {
    let failed!: () => void;
    const failure = new Promise<void>((resolve) => { failed = resolve; });
    const values = [42];
    const stop = startActivityPoll({
      load: (signal) => new Promise<number>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })),
      receive: (value) => { values.push(value); }, failed, intervalMs: 1000, timeoutMs: 5,
    });
    await failure;
    stop();
    expect(values).toEqual([42]);
  });
});


test('rejects incomplete or malformed network status instead of crashing the disclosure', () => {
  expect(() => parseActivityHealth({ status: 'current', chains: [null, null, null, null] })).toThrow();
  expect(() => parseActivityHealth({ status: 'toString', chains: [] })).toThrow();
});

test('timeout becomes visible even if an in-flight reader ignores abort', async () => {
  let release!: (value: number) => void;
  let failures = 0;
  const values: number[] = [];
  const stop = startActivityPoll({
    load: () => new Promise<number>((resolve) => { release = resolve; }),
    receive: (value) => { values.push(value); }, failed: () => { failures++; }, intervalMs: 1000, timeoutMs: 5,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(failures).toBe(1);
  release(99);
  await new Promise((resolve) => setTimeout(resolve, 2));
  stop();
  expect(values).toEqual([]);
});

test('inactive indexing is not presented as a previously running paused scanner', async () => {
  const { INDEXING_STATUS_LABELS } = await import('./live-flow-state');
  expect(INDEXING_STATUS_LABELS.disabled).toBe('Not enabled');
});

test('coverage accepts only known public issue codes', async () => {
  const { buildIndexingHealth } = await import('@/lib/indexing-health');
  const value = buildIndexingHealth([]);
  value.chains[0].paths[0].issue = 'http://provider.invalid/SECRET' as never;
  expect(() => parseActivityHealth(value)).toThrow('Invalid network coverage');
});
