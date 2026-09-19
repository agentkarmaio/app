import { afterEach, describe, expect, test } from 'bun:test';
import * as db from './client';

afterEach(() => db.__setSupabaseForTest(null));

function recordQueries() {
  const queries: { table: string; predicates: unknown[][]; updates: unknown[] }[] = [];
  db.__setSupabaseForTest({ from(table: string) {
    const query = { table, predicates: [] as unknown[][], updates: [] as unknown[] };
    queries.push(query);
    const b: Record<string, unknown> = {};
    for (const verb of ['select', 'order', 'limit', 'range', 'or']) b[verb] = () => b;
    for (const verb of ['eq', 'neq', 'in', 'not', 'gt']) b[verb] = (...args: unknown[]) => {
      query.predicates.push([verb, ...args]); return b;
    };
    b.update = (row: unknown) => { query.updates.push(row); return b; };
    b.upsert = (row: unknown) => { query.updates.push(row); return b; };
    b.maybeSingle = async () => ({ data: null, error: null });
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ data: [], error: null, count: 0 }));
    return b;
  } });
  return queries;
}

describe('Arc testnet retirement data boundaries', () => {
  test('retired rankings are empty without querying or altering history', async () => {
    const queries = recordQueries();
    expect(await db.getAgents(25, 0, { chain: 'arc' })).toEqual({ wallets: [], total: 0 });
    expect(await db.getLeaderboard(25, 0, { chain: 'arc' })).toEqual({ wallets: [], total: 0 });
    expect(queries).toEqual([]);
  });

  for (const [name, read] of [
    ['leaderboard', () => db.getLeaderboard()],
    ['claimed discovery', () => db.getAgents(25, 0, { claimed: true })],
    ['search', () => db.searchWallets('APEX')],
    ['recent activity', () => db.getRecentTransactions()],
    ['estates', () => db.getReapableSuccessions()],
    ['sureties', () => db.getSuretyLeaderboard()],
  ] as const) {
    test(`${name} excludes testnet before pagination`, async () => {
      const queries = recordQueries();
      await read();
      expect(queries[0].predicates).toContainEqual(['neq', 'chain', 'arc']);
    });
  }

  test('generic scoring leaves archived rows and dirty flags untouched', async () => {
    const queries = recordQueries();
    await db.markWalletsDirty([{ chain: 'arc', address: 'archived' }]);
    expect(queries).toEqual([]);
    await db.markAllWalletsDirty();
    await db.claimDirtyWallets();
    await db.countDirtyWallets();
    for (const query of queries) expect(query.predicates).toContainEqual(['neq', 'chain', 'arc']);
  });

  test('registry totals default to active registry networks', async () => {
    const queries = recordQueries();
    await db.getRegistryStats();
    const chains = queries.flatMap(q => q.predicates.filter(p => p[0] === 'eq' && p[1] === 'chain').map(p => p[2]));
    expect(new Set(chains)).toEqual(new Set(['celo', 'stellar', 'arc-mainnet']));
  });

  test('archived successions cannot crowd the active heartbeat batch', async () => {
    const queries = recordQueries();
    expect(await db.listSuccessionsForHeartbeat(10, 'arc')).toEqual([]);
    expect(queries).toEqual([]);
    await db.listSuccessionsForHeartbeat(10);
    expect(queries[0].predicates).toContainEqual(['neq', 'chain', 'arc']);
  });

  test('testnet scan requests cannot create or refresh archived wallets', async () => {
    const queries = recordQueries();
    await expect(db.enqueueWalletScan('archived', 'arc')).rejects.toThrow('arc_testnet_retired');
    expect(queries).toEqual([]);
  });

  test('active manifest address updates cannot touch another network', async () => {
    const queries = recordQueries();
    await db.setWalletTempoAddress('shared', 'tempo', 'celo');
    expect(queries[0].predicates).toContainEqual(['eq', 'chain', 'celo']);
  });
});
