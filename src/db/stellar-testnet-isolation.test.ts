/// <reference types="bun-types" />
/**
 * stellar-testnet is API-only (Kerem, 2026-10-14). Its rows live in the shared
 * tables under their own chain key and are scored by the normal rescore queue,
 * but no public surface — rankings, search, activity, estates, sureties,
 * totals — may ever include them. These tests pin both directions.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as db from './client';
import { CHAINS, NON_PUBLIC_CHAINS, isPublicChain, isApiOnlyChain } from './schema';

afterEach(() => db.__setSupabaseForTest(null));

function recordQueries() {
  const queries: { table: string; predicates: unknown[][] }[] = [];
  db.__setSupabaseForTest({ from(table: string) {
    const query = { table, predicates: [] as unknown[][] };
    queries.push(query);
    const b: Record<string, unknown> = {};
    for (const verb of ['select', 'order', 'limit', 'range', 'or', 'update', 'upsert']) b[verb] = () => b;
    for (const verb of ['eq', 'neq', 'in', 'not', 'gt', 'gte', 'is', 'lt']) b[verb] = (...args: unknown[]) => {
      query.predicates.push([verb, ...args]); return b;
    };
    b.maybeSingle = async () => ({ data: null, error: null });
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ data: [], error: null, count: 0 }));
    return b;
  } });
  return queries;
}

const TESTNET = ['neq', 'chain', 'stellar-testnet'];
const ARC = ['neq', 'chain', 'arc'];

describe('chain sets', () => {
  test('stellar-testnet is a known chain but not a public one', () => {
    expect(CHAINS).toContain('stellar-testnet');
    expect(NON_PUBLIC_CHAINS).toContain('stellar-testnet');
    expect(isPublicChain('stellar-testnet')).toBe(false);
    expect(isPublicChain('arc')).toBe(false);
    expect(isPublicChain('stellar')).toBe(true);
    expect(isApiOnlyChain('stellar-testnet')).toBe(true);
    expect(isApiOnlyChain('stellar')).toBe(false);
  });
});

describe('public reads exclude stellar-testnet before pagination', () => {
  for (const [name, read] of [
    ['leaderboard', () => db.getLeaderboard()],
    ['leaderboard (chain=stellar)', () => db.getLeaderboard(25, 0, { chain: 'stellar' })],
    ['claimed discovery', () => db.getAgents(25, 0, { claimed: true })],
    ['solana explore', () => db.getAgents(25, 0, { chain: 'solana' })],
    ['search', () => db.searchWallets('APEX')],
    ['recent activity', () => db.getRecentTransactions()],
    ['estates', () => db.getReapableSuccessions()],
    ['sureties', () => db.getSuretyLeaderboard()],
  ] as const) {
    test(name, async () => {
      const queries = recordQueries();
      await read();
      expect(queries[0].predicates).toContainEqual(TESTNET);
      expect(queries[0].predicates).toContainEqual(ARC);
    });
  }

  test('All-chains explore reads the mainnet view, which never unions testnet', async () => {
    const queries = recordQueries();
    await db.getAgents();
    expect(queries[0].table).toBe('explore_agents');
  });

  test('public rankings asked for testnet return empty without querying', async () => {
    const queries = recordQueries();
    expect(await db.getLeaderboard(25, 0, { chain: 'stellar-testnet' })).toEqual({ wallets: [], total: 0 });
    expect(await db.getSuretyLeaderboard(25, 0, { chain: 'stellar-testnet' })).toEqual({ wallets: [], total: 0 });
    expect(await db.getReapableSuccessions(25, 0, { chain: 'stellar-testnet' })).toEqual({ successions: [], total: 0 });
    expect(queries).toEqual([]);
  });

  test('registry totals default to public networks only', async () => {
    const queries = recordQueries();
    await db.getRegistryStats();
    const chains = queries.flatMap(q => q.predicates.filter(p => p[0] === 'eq' && p[1] === 'chain').map(p => p[2]));
    expect(chains).not.toContain('stellar-testnet');
  });
});

describe('API reads for stellar-testnet', () => {
  test('explore with chain=stellar-testnet reads only the testnet view', async () => {
    const queries = recordQueries();
    await db.getAgents(25, 0, { chain: 'stellar-testnet' });
    expect(queries.map(q => q.table)).toEqual(['stellar_testnet_agents']);
    expect(queries[0].predicates).toContainEqual(['eq', 'chain', 'stellar-testnet']);
  });

  test('claimed=true on testnet still reads the testnet view (no raw wallets fallthrough)', async () => {
    const queries = recordQueries();
    await db.getAgents(25, 0, { chain: 'stellar-testnet', claimed: true });
    expect(queries.map(q => q.table)).toEqual(['stellar_testnet_agents']);
  });

  test('agentId resolution reads the testnet view by registry id, agent 0 included', async () => {
    const queries = recordQueries();
    await db.getWalletByAgentId('stellar-testnet', 0);
    expect(queries[0].table).toBe('stellar_testnet_agents');
    expect(queries[0].predicates).toContainEqual(['eq', 'stellar_agent_id', 0]);
  });

  test('registry stats include testnet only when asked explicitly', async () => {
    const queries = recordQueries();
    await db.getRegistryStats(['stellar-testnet']);
    expect(queries.every(q => q.predicates.some(p => p[0] === 'eq' && p[2] === 'stellar-testnet'))).toBe(true);
  });
});

describe('testnet is still scored by the normal queue', () => {
  test('dirty-queue reads do not exclude stellar-testnet', async () => {
    const queries = recordQueries();
    await db.markAllWalletsDirty();
    await db.claimDirtyWallets();
    await db.countDirtyWallets();
    for (const q of queries) expect(q.predicates).not.toContainEqual(TESTNET);
  });

  test('marking a testnet wallet dirty issues a write', async () => {
    const queries = recordQueries();
    await db.markWalletsDirty([{ chain: 'stellar-testnet', address: 'GTEST' }]);
    expect(queries.length).toBeGreaterThan(0);
  });

  test('wallet-scan requests (no testnet adapter) are refused', async () => {
    const queries = recordQueries();
    await expect(db.enqueueWalletScan('GTEST', 'stellar-testnet')).rejects.toThrow('api_only_chain');
    expect(queries).toEqual([]);
  });
});
