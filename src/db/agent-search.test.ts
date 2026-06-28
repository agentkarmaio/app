/// <reference types="bun-types" />
/**
 * searchWallets agentId matching + getWalletByAgentId chain→column resolution.
 * We stub Supabase (via __setSupabaseForTest) and record the `.or()` filter and
 * `.eq()` calls, asserting that a numeric query adds exact agentId clauses and
 * that the resolver maps each chain to the right wallets column (and short-
 * circuits for Solana / out-of-range ids without touching the DB).
 */
import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import { __setSupabaseForTest, searchWallets, getWalletByAgentId } from './client';

afterAll(() => { __setSupabaseForTest(null); });

type Recorded = {
  table: string;
  select?: string;
  or?: string;
  eqs: Array<[string, unknown]>;
  orders: string[];
  limit?: number;
};

function fakeSupabase(rows: unknown[], recorder: Recorded[]) {
  return {
    from(table: string) {
      const rec: Recorded = { table, eqs: [], orders: [] };
      recorder.push(rec);
      const result = { data: rows, error: null };
      const builder: Record<string, unknown> = {};
      builder.select = (sel: string) => { rec.select = sel; return builder; };
      builder.or = (f: string) => { rec.or = f; return builder; };
      builder.eq = (col: string, val: unknown) => { rec.eqs.push([col, val]); return builder; };
      builder.order = (col: string) => { rec.orders.push(col); return builder; };
      builder.limit = (n: number) => { rec.limit = n; return Promise.resolve(result); };
      return builder;
    },
  };
}

describe('searchWallets agentId matching', () => {
  let rec: Recorded[];
  const seed = (rows: unknown[]) => __setSupabaseForTest(fakeSupabase(rows, rec));
  beforeEach(() => { rec = []; });

  test('non-numeric query matches address + display_name only', async () => {
    seed([]);
    await searchWallets('alice');
    expect(rec[0].or).toBe('address.ilike.%alice%,display_name.ilike.%alice%');
  });

  test('numeric query adds exact agentId eq clauses for every chain', async () => {
    seed([]);
    await searchWallets('9058');
    expect(rec[0].or).toBe(
      'address.ilike.%9058%,display_name.ilike.%9058%,' +
      'celo_agent_id.eq.9058,arc_agent_id.eq.9058,stellar_agent_id.eq.9058',
    );
  });

  test('out-of-int32-range numeric query skips agentId clauses', async () => {
    seed([]);
    await searchWallets('99999999999'); // > 2^31-1
    expect(rec[0].or).toBe('address.ilike.%99999999999%,display_name.ilike.%99999999999%');
  });

  test('sub-3-char numeric query stays resolver-only (returns empty, no query)', async () => {
    seed([]);
    const out = await searchWallets('42');
    expect(out).toEqual([]);
    expect(rec).toHaveLength(0);
  });

  test('maps the matched agentId from the row’s chain column', async () => {
    seed([
      { address: '0xabc', chain: 'celo', display_name: 'A', score: '50', trust_tier: 'Good',
        tx_count: 1, celo_agent_id: 9058, arc_agent_id: null, stellar_agent_id: null },
      { address: 'So1ana', chain: 'solana', display_name: 'B', score: '40', trust_tier: 'Fair',
        tx_count: 2, celo_agent_id: null, arc_agent_id: null, stellar_agent_id: null },
    ]);
    const out = await searchWallets('9058');
    expect(out[0].agentId).toBe(9058);
    expect(out[1].agentId).toBeNull(); // solana has no agentId column
  });
});

describe('getWalletByAgentId chain→column resolution', () => {
  let rec: Recorded[];
  const seed = (rows: unknown[]) => __setSupabaseForTest(fakeSupabase(rows, rec));
  beforeEach(() => { rec = []; });

  test('celo resolves on celo_agent_id', async () => {
    seed([{ address: '0xabc', chain: 'celo', score: '50' }]);
    const w = await getWalletByAgentId('celo', 9058);
    expect(rec[0].eqs).toEqual([['chain', 'celo'], ['celo_agent_id', 9058]]);
    expect(w?.address).toBe('0xabc');
  });

  test('arc resolves on arc_agent_id', async () => {
    seed([{ address: '0xdef', chain: 'arc' }]);
    await getWalletByAgentId('arc', 72077);
    expect(rec[0].eqs).toEqual([['chain', 'arc'], ['arc_agent_id', 72077]]);
  });

  test('stellar resolves on stellar_agent_id', async () => {
    seed([{ address: 'GABC', chain: 'stellar' }]);
    await getWalletByAgentId('stellar', 14);
    expect(rec[0].eqs).toEqual([['chain', 'stellar'], ['stellar_agent_id', 14]]);
  });

  test('solana short-circuits to null without querying', async () => {
    seed([]);
    expect(await getWalletByAgentId('solana', 1)).toBeNull();
    expect(rec).toHaveLength(0);
  });

  test('out-of-int32-range id short-circuits to null without querying', async () => {
    seed([]);
    expect(await getWalletByAgentId('celo', 99999999999)).toBeNull();
    expect(rec).toHaveLength(0);
  });

  test('unknown id returns null', async () => {
    seed([]);
    expect(await getWalletByAgentId('celo', 123456)).toBeNull();
  });
});
