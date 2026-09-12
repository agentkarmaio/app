import { describe, expect, test } from 'bun:test';
import { arcRegistryRefresh, type ArcRegistryRefreshDeps } from './arc-registry-refresh';

function fixture(overrides: Partial<ArcRegistryRefreshDeps> = {}) {
  const calls: number[][] = [];
  const checkpoints: number[] = [];
  let checkpoint = 0;
  const deps: ArcRegistryRefreshDeps = {
    loadKnownIds: async () => [2, 70, 845000],
    readCheckpoint: async () => checkpoint,
    writeCheckpoint: async (value) => { checkpoint = value; checkpoints.push(value); },
    scanIds: async (ids) => { calls.push(ids); return {
      chain: 'arc', tip: ids.at(-1) ?? 0, agentsScanned: ids.length, agentsPersisted: ids.length,
      feedbackScanned: 0, feedbackPersisted: 0, errors: 0,
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
    expect(f.checkpoints.at(-1)).toBe(0);
  });
  test('error holds the checkpoint before the failed batch and retries it', async () => {
    const f = fixture({ scanIds: async (ids) => ({ chain: 'arc', tip: ids.at(-1)!, agentsScanned: 0, agentsPersisted: 0, feedbackScanned: 0, feedbackPersisted: 0, errors: 1 }) });
    const result = await arcRegistryRefresh(f.deps);
    expect(f.checkpoints).toEqual([]);
    expect(result.coverage).toMatchObject({ complete: false, pending: 3, unresolved: 1, checkpoint: '0' });
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

test('cancellation after a registry batch does not bank its scheduling checkpoint', async () => {
  const controller = new AbortController();
  const f = fixture({ signal: controller.signal });
  const scan = f.deps.scanIds;
  f.deps.scanIds = async (ids) => { const result = await scan(ids); controller.abort(Error('stop_registry')); return result; };
  await expect(arcRegistryRefresh(f.deps)).rejects.toThrow('stop_registry');
  expect(f.calls).toHaveLength(1);
  expect(f.checkpoints).toEqual([]);
});
