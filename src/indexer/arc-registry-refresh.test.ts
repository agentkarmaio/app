import { describe, expect, test } from 'bun:test';
import { arcRegistryRefresh, parseArcRegistryRefreshState, readArcRegistryRefreshCheckpoint, writeArcRegistryRefreshCheckpoint,
  type ArcRegistryRefreshDeps, type ArcRegistryRefreshState } from './arc-registry-refresh';
import { runRegistryScan, type ScannedAgent } from './erc8004-registry';
import type { Erc8004RegistryConfig } from '@/config/erc8004-registries';
import { __setSupabaseForTest, upsertCursor } from '@/db/client';
import type { IndexerCursor } from '@/db/schema';

function fixture(overrides: Partial<ArcRegistryRefreshDeps> = {}) {
  const calls: number[][] = [];
  const checkpoints: number[] = [];
  let checkpoint: number | ArcRegistryRefreshState = 0;
  const deps: ArcRegistryRefreshDeps = {
    loadKnownIds: async () => [2, 70, 845000],
    readCheckpoint: async () => checkpoint,
    writeCheckpoint: async (value, state) => { checkpoint = structuredClone(state); checkpoints.push(value); },
    scanIds: async (ids) => { calls.push(ids); return {
      chain: 'arc', tip: ids.at(-1) ?? 0, agentsScanned: ids.length, agentsPersisted: ids.length,
      feedbackScanned: 0, feedbackPersisted: 0, errors: 0, failedMembers: [],
    }; },
    maxIds: 2, batchSize: 1, now: () => 0, timeBudgetMs: 120_000,
    ...overrides,
  };
  return { deps, calls, checkpoints };
}

describe('bounded refresh never widens Arc membership', () => {
  test('rotates only through exact existing IDs and resets after a full rotation', async () => {
    const f = fixture();
    const first = await arcRegistryRefresh(f.deps);
    expect(f.calls.flat()).toEqual([2, 70]);
    expect(first.coverage).toMatchObject({ complete: false, checked: 2, pending: 1, checkpoint: '70' });
    const second = await arcRegistryRefresh(f.deps);
    expect(f.calls.flat()).toEqual([2, 70, 845000]);
    expect(second.coverage).toMatchObject({ complete: true, checked: 1, pending: 0 });
    expect(f.checkpoints.at(-1)).toBe(845000);
    await arcRegistryRefresh(f.deps);
    expect(f.calls.slice(-2).flat()).toEqual([2, 70]);
  });
  test('unknown batch errors advance scheduling with durable conservative failures', async () => {
    const f = fixture({ scanIds: async (ids) => ({ chain: 'arc', tip: ids.at(-1)!, agentsScanned: 0, agentsPersisted: 0, feedbackScanned: 0, feedbackPersisted: 0, errors: 1 }) });
    const result = await arcRegistryRefresh(f.deps);
    expect(f.checkpoints).toEqual([2, 70]);
    expect(result.coverage).toMatchObject({ complete: false, pending: 1, unresolved: 2, checkpoint: '70' });
    expect((await f.deps.readCheckpoint() as ArcRegistryRefreshState).failures).toEqual([
      { agentId: 2, stages: ['unknown'] }, { agentId: 70, stages: ['unknown'] },
    ]);
  });
  test('budget expiry leaves untouched IDs pending without scanning', async () => {
    let time = 0;
    const f = fixture({ now: () => time });
    const scan = f.deps.scanIds;
    f.deps.scanIds = async (ids) => { const result = await scan(ids); time = 120_000; return result; };
    const result = await arcRegistryRefresh(f.deps);
    expect(f.calls.flat()).toEqual([2]);
    expect(result.coverage).toMatchObject({ complete: false, checked: 1, pending: 2, reason: 'time_budget' });
  });
  test('membership expansion fails closed before RPC or cursor writes', async () => {
    const f = fixture({ loadKnownIds: async () => Array.from({ length: 2753 }, (_, i) => i + 1) });
    await expect(arcRegistryRefresh(f.deps)).rejects.toThrow('2752');
    expect(f.calls).toEqual([]);
    expect(f.checkpoints).toEqual([]);
  });
  test('empty membership is dormant', async () => {
    const f = fixture({ loadKnownIds: async () => [] });
    const result = await arcRegistryRefresh(f.deps);
    expect(result.coverage).toMatchObject({ complete: false, checked: 0, pending: 0, reason: 'empty_seed' });
  });
});

test('a permanently failing first member never starves later IDs or disappears across restart', async () => {
  const f = fixture();
  const scan = f.deps.scanIds;
  f.deps.scanIds = async (ids) => ({ ...await scan(ids), errors: ids.includes(2) ? 1 : 0,
    failedMembers: ids.includes(2) ? [{ agentId: 2, stages: ['identity'] }] : [] });
  for (let run = 0; run < 4; run++) {
    const result = await arcRegistryRefresh({ ...f.deps });
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.unresolved).toBe(1);
    expect((await f.deps.readCheckpoint() as ArcRegistryRefreshState).failures).toEqual([{ agentId: 2, stages: ['identity'] }]);
  }
  expect(f.calls.flat()).toContain(845000);
  expect(f.calls.flat().filter(id => id === 2).length).toBeGreaterThan(1);
});

test('retry IDs rotate fairly and retain all failure stages until an exhaustive successful scan', async () => {
  const f = fixture({ maxIds: 2, loadKnownIds: async () => [2, 70, 845000] });
  const initial: ArcRegistryRefreshState = { version: 1, position: 0, retryAfter: 0, retryNext: true,
    failures: [{ agentId: 2, stages: ['identity'] }, { agentId: 70, stages: ['feedback'] }] };
  await f.deps.writeCheckpoint(0, initial);
  const scan = f.deps.scanIds;
  f.deps.scanIds = async ids => ({ ...await scan(ids), errors: 1,
    failedMembers: ids.map(agentId => ({ agentId, stages: ['registration'] })) });
  await arcRegistryRefresh(f.deps);
  const saved = await f.deps.readCheckpoint() as ArcRegistryRefreshState;
  expect(saved.failures.find(row => row.agentId === 2)?.stages).toEqual(['identity', 'registration']);
  await arcRegistryRefresh(f.deps);
  expect((await f.deps.readCheckpoint() as ArcRegistryRefreshState).retryAfter).toBe(70);
  // A legacy/missing-detail result cannot erase previously unresolved evidence.
  f.deps.scanIds = async ids => { const result = await scan(ids); delete result.failedMembers; return result; };
  await arcRegistryRefresh(f.deps);
  expect((await f.deps.readCheckpoint() as ArcRegistryRefreshState).failures.length).toBeGreaterThan(0);
  f.deps.scanIds = scan;
  for (let i = 0; i < 5; i++) await arcRegistryRefresh(f.deps);
  expect((await f.deps.readCheckpoint() as ArcRegistryRefreshState).failures).toEqual([]);
});

test.each([1, 4])('wall time and %i-member budgets alternate retry and fresh priority durably', async maxIds => {
  let time = 0;
  const f = fixture({ maxIds, now: () => time, timeBudgetMs: 10 });
  await f.deps.writeCheckpoint(2, { version: 1, position: 2, retryAfter: 0, retryNext: true,
    membership: [2, 70, 845000],
    failures: [{ agentId: 2, stages: ['feedback'] }] });
  const scan = f.deps.scanIds;
  f.deps.scanIds = async ids => { time += 10; return { ...await scan(ids), errors: ids.includes(2) ? 1 : 0,
    failedMembers: ids.includes(2) ? [{ agentId: 2, stages: ['feedback'] }] : [] }; };
  for (let i = 0; i < 4; i++) await arcRegistryRefresh({ ...f.deps });
  expect(f.calls.flat()).toEqual([2, 70, 2, 845000]);
});

test('a persisted batch remains recoverable when cancellation arrives during its atomic cursor write', async () => {
  const controller = new AbortController();
  const f = fixture({ signal: controller.signal });
  const write = f.deps.writeCheckpoint;
  f.deps.writeCheckpoint = async (position, state) => { await write(position, state); controller.abort(Error('stop_after_commit')); };
  const scan = f.deps.scanIds;
  f.deps.scanIds = async ids => ({ ...await scan(ids), errors: 1,
    failedMembers: ids.map(agentId => ({ agentId, stages: ['identity'] })) });
  await expect(arcRegistryRefresh(f.deps)).rejects.toThrow('stop_after_commit');
  expect(await f.deps.readCheckpoint()).toMatchObject({ position: 2, failures: [{ agentId: 2, stages: ['identity'] }] });
  f.deps.signal = undefined;
  f.deps.writeCheckpoint = write;
  await arcRegistryRefresh(f.deps);
  expect(f.calls.flat()).toContain(70);
});

test('failed retries cannot spend the reserved fresh-member quota', async () => {
  const f = fixture({ loadKnownIds: async () => [1, 2, 3, 4, 5, 6, 7, 8], maxIds: 4, batchSize: 10 });
  await f.deps.writeCheckpoint(4, { version: 1, position: 4, retryAfter: 0, retryNext: true,
    membership: [1, 2, 3, 4, 5, 6, 7, 8],
    failures: [1, 2, 3, 4].map(agentId => ({ agentId, stages: ['identity'] })) });
  const scan = f.deps.scanIds;
  f.deps.scanIds = async ids => ({ ...await scan(ids), errors: ids.filter(id => id < 5).length,
    failedMembers: ids.filter(id => id < 5).map(agentId => ({ agentId, stages: ['identity'] })) });
  const result = await arcRegistryRefresh(f.deps);
  expect(f.calls).toEqual([[1], [5, 6, 7]]);
  expect(result.coverage).toMatchObject({ checked: 4, pending: 1, unresolved: 4, complete: false });
});

test('ledger write failure never banks scheduling or clears previous failure evidence', async () => {
  const f = fixture();
  const initial: ArcRegistryRefreshState = { version: 1, position: 2, retryAfter: 0, retryNext: false,
    failures: [{ agentId: 2, stages: ['feedback'] }] };
  await f.deps.writeCheckpoint(2, initial);
  const original = f.deps.writeCheckpoint;
  f.deps.writeCheckpoint = async () => { throw Error('write_failed'); };
  await expect(arcRegistryRefresh(f.deps)).rejects.toThrow('write_failed');
  expect(await f.deps.readCheckpoint()).toEqual(initial);
  f.deps.writeCheckpoint = original;
  await arcRegistryRefresh(f.deps);
  expect(f.calls[0]).toEqual(f.calls[1]);
});

test('feedback failure preserves stored aggregates; retry clears only after enriched writes succeed', async () => {
  const config = { chain: 'arc', identityRegistry: '0x0', reputationRegistry: '0x0', rpcEnvVar: 'X', viemChain: {} } as unknown as Erc8004RegistryConfig;
  const f = fixture({ loadKnownIds: async () => [2], maxIds: 1 });
  let stored: Partial<ScannedAgent> = { agentId: 2, feedback: { count: 5, sum: 25, avg: 5 } };
  let readFails = true;
  let aggregateWriteFails = false;
  f.deps.scanIds = agentIds => runRegistryScan(config, async (_chain, rows) => {
    for (const row of rows) {
      if (row.feedback && aggregateWriteFails) throw Error('aggregate_write_failed');
      stored = { ...stored, ...row };
    }
    return rows.length;
  }, async () => 0, {
    agentIds, fetchRemote: false,
    client: {
      readContract: (async () => { throw Error('tip forbidden'); }) as never,
      multicall: (async ({ contracts }: { contracts: { functionName: string }[] }) => contracts.map(c => {
        if (c.functionName === 'readAllFeedback') return readFails ? { status: 'failure' }
          : { status: 'success', result: [[], [], [], [], [], [], []] };
        return { status: 'success', result: c.functionName === 'tokenURI' ? '' : '0xAA' };
      })) as never,
    },
  });
  await arcRegistryRefresh(f.deps);
  expect(stored.owner).toBe('0xaa');
  expect(stored.feedback).toEqual({ count: 5, sum: 25, avg: 5 });
  const saved = await f.deps.readCheckpoint();
  expect(saved).toMatchObject({ failures: [{ agentId: 2, stages: ['feedback'] }] });
  readFails = false;
  aggregateWriteFails = true;
  await expect(arcRegistryRefresh(f.deps)).rejects.toThrow('aggregate_write_failed');
  expect(await f.deps.readCheckpoint()).toEqual(saved);
  expect(stored.feedback?.count).toBe(5);
  aggregateWriteFails = false;
  await arcRegistryRefresh(f.deps);
  expect((await f.deps.readCheckpoint() as ArcRegistryRefreshState).failures).toEqual([]);
  expect(stored.feedback?.count).toBe(0);
});

test('removed failed members remain unresolved without widening scans', async () => {
  const f = fixture({ loadKnownIds: async () => [70], maxIds: 4 });
  await f.deps.writeCheckpoint(2, { version: 1, position: 2, retryAfter: 0, retryNext: true,
    failures: [{ agentId: 2, stages: ['identity'] }] });
  const result = await arcRegistryRefresh(f.deps);
  expect(f.calls.flat()).toEqual([70]);
  expect(result.coverage).toMatchObject({ complete: false, pending: 0, unresolved: 1 });
});

test('a newly approved member below the scheduling position restarts the rotation', async () => {
  let ids = [2, 70, 845000];
  const f = fixture({ loadKnownIds: async () => ids, maxIds: 1 });
  await arcRegistryRefresh(f.deps);
  ids = [1, 2, 70, 845000];
  const result = await arcRegistryRefresh(f.deps);
  expect(f.calls.flat()).toEqual([2, 1]);
  expect(result.coverage).toMatchObject({ complete: false, pending: 3 });
});

test('legacy numeric checkpoint repeats the approved population before claiming complete coverage', async () => {
  const f = fixture({ readCheckpoint: async () => 70, maxIds: 1 });
  const result = await arcRegistryRefresh(f.deps);
  expect(f.calls.flat()).toEqual([2]);
  expect(result.coverage).toMatchObject({ complete: false, pending: 2 });
});

test('versioned cursor parsing retains failures and rejects corruption rather than resetting', () => {
  const state: ArcRegistryRefreshState = { version: 1, position: 70, retryAfter: 2, retryNext: true,
    failures: [{ agentId: 2, stages: ['feedback'] }] };
  expect(parseArcRegistryRefreshState(JSON.stringify(state), 70)).toEqual(state);
  expect(parseArcRegistryRefreshState('70', 70)).toMatchObject({ position: 70, failures: [] });
  expect(parseArcRegistryRefreshState(null, null)).toMatchObject({ position: 0, failures: [] });
  for (const value of ['{broken', '{"version":2}', JSON.stringify({ ...state, failures: [{ agentId: 2, stages: ['bad'] }] })]) {
    expect(() => parseArcRegistryRefreshState(value, 70)).toThrow();
  }
  expect(() => parseArcRegistryRefreshState(JSON.stringify(state), 2)).toThrow();
});

test('old cursor writers cannot overwrite the isolated failure ledger or bypass its validation', async () => {
  const rows = new Map<string, IndexerCursor>();
  const written: string[] = [];
  __setSupabaseForTest({ from: () => {
    const filters = new Map<string, unknown>();
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.set(key, value); return query; },
      single: async () => {
        const row = rows.get(`${filters.get('chain')}:${filters.get('facilitator')}`);
        return { data: row ?? null, error: row ? null : { code: 'PGRST116' } };
      },
      upsert: async (row: IndexerCursor) => {
        rows.set(`${row.chain}:${row.facilitator}`, structuredClone(row));
        written.push(row.facilitator);
        return { error: null };
      },
    };
    return query;
  } });
  try {
    await upsertCursor('arc:registry-refresh', '70', 70, 'arc');
    expect(await readArcRegistryRefreshCheckpoint()).toMatchObject({ position: 70, failures: [] });
    const f = fixture({ readCheckpoint: readArcRegistryRefreshCheckpoint,
      writeCheckpoint: writeArcRegistryRefreshCheckpoint, maxIds: 1 });
    const scan = f.deps.scanIds;
    f.deps.scanIds = async ids => ({ ...await scan(ids), errors: 1,
      failedMembers: [{ agentId: 2, stages: ['feedback'] }] });
    await arcRegistryRefresh(f.deps);
    expect(f.calls.flat()).toEqual([2]);
    expect(written).toEqual(['arc:registry-refresh', 'arc:registry-refresh:v2']);
    const checkpoint = await readArcRegistryRefreshCheckpoint();
    expect(checkpoint.failures).toEqual([{ agentId: 2, stages: ['feedback'] }]);
    await upsertCursor('arc:registry-refresh', '845000', 845000, 'arc');
    expect(await readArcRegistryRefreshCheckpoint()).toEqual(checkpoint);
    expect((await arcRegistryRefresh(f.deps)).coverage.complete).toBe(false);
    await upsertCursor('arc:registry-refresh:v2', '845000', 845000, 'arc');
    await expect(readArcRegistryRefreshCheckpoint()).rejects.toThrow();
    await upsertCursor('arc:registry-refresh:v2', '{broken', 2, 'arc');
    await expect(readArcRegistryRefreshCheckpoint()).rejects.toThrow();
  } finally { __setSupabaseForTest(null); }
});

test('cancellation after a registry batch does not bank its scheduling checkpoint', async () => {
  const controller = new AbortController();
  const f = fixture({ signal: controller.signal });
  const scan = f.deps.scanIds;
  f.deps.scanIds = async (ids) => { const result = await scan(ids); controller.abort(Error('stop_registry')); return result; };
  await expect(arcRegistryRefresh(f.deps)).rejects.toThrow('stop_registry');
  expect(f.calls).toHaveLength(1);
  expect(f.checkpoints).toEqual([]);
});
