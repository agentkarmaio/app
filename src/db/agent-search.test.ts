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
      builder.neq = () => builder;
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

describe('searchWallets registry names', () => {
  // Per-table rows: `wallets` holds address-keyed rows (few carry a name);
  // `explore_agents` carries every ERC-8004 registry agent's registration name.
  function tableFake(byTable: Record<string, unknown[]>, recorder: Recorded[]) {
    return {
      from(table: string) {
        const rec: Recorded = { table, eqs: [], orders: [] };
        recorder.push(rec);
        const builder: Record<string, unknown> = {};
        builder.select = (sel: string) => { rec.select = sel; return builder; };
        builder.neq = (col: string, val: unknown) => { rec.eqs.push([`neq:${col}`, val]); return builder; };
        builder.or = (f: string) => { rec.or = f; return builder; };
        builder.order = (col: string) => { rec.orders.push(col); return builder; };
        builder.limit = (n: number) => {
          rec.limit = n;
          return Promise.resolve({ data: byTable[table] ?? [], error: null });
        };
        return builder;
      },
    };
  }
  let rec: Recorded[];
  beforeEach(() => { rec = []; });

  // Solana base58 addresses contain "apex" case-insensitively, out-score the
  // named registry agents, and filled all 8 slots — named agents never showed.
  const addressHit = (n: number) => ({
    address: `So1${n}ApeXaddr`, chain: 'solana', display_name: null, score: '38', trust_tier: 'Poor',
    tx_count: 1, celo_agent_id: null, arc_agent_id: null, stellar_agent_id: null,
  });

  test('a registry agent name match surfaces above address-substring matches', async () => {
    __setSupabaseForTest(tableFake({
      wallets: Array.from({ length: 8 }, (_, i) => addressHit(i)),
      explore_agents: [{
        address: '0x024b', chain: 'celo', display_name: 'APEX Faucet', score: '90',
        trust_tier: 'Very Good', tx_count: 0, celo_agent_id: 9886, arc_agent_id: null, stellar_agent_id: null,
      }],
    }, rec));

    const out = await searchWallets('apex', 8);

    expect(out).toHaveLength(8);
    expect(out[0]).toMatchObject({ displayName: 'APEX Faucet', chain: 'celo', address: '0x024b', agentId: 9886 });
  });

  test('registry query matches names only, on non-Solana public chains', async () => {
    __setSupabaseForTest(tableFake({}, rec));
    await searchWallets('apex');
    const reg = rec.find((r) => r.table === 'explore_agents');
    expect(reg?.or).toBe('display_name.ilike.%apex%');
    expect(reg?.eqs).toContainEqual(['neq:chain', 'solana']);
    expect(reg?.eqs).toContainEqual(['neq:chain', 'arc']);
  });

  test('numeric query also matches registry agentIds, ranked above address hits', async () => {
    __setSupabaseForTest(tableFake({
      wallets: [{ ...addressHit(0), address: '0x9058aa', chain: 'arc-mainnet', score: '5' }],
      explore_agents: [{
        address: '0xak', chain: 'celo', display_name: 'AgentKarma', score: '0', trust_tier: 'Unrated',
        tx_count: 0, celo_agent_id: 9058, arc_agent_id: null, stellar_agent_id: null,
      }],
    }, rec));
    const out = await searchWallets('9058');
    expect(rec.find((r) => r.table === 'explore_agents')?.or).toBe(
      'display_name.ilike.%9058%,celo_agent_id.eq.9058,arc_agent_id.eq.9058,stellar_agent_id.eq.9058,robinhood_agent_id.eq.9058',
    );
    expect(out[0]).toMatchObject({ address: '0xak', agentId: 9058 });
  });

  test('the same agent from both sources appears once', async () => {
    const row = {
      address: '0xak', chain: 'celo', display_name: 'AgentKarma', score: '80', trust_tier: 'Good',
      tx_count: 3, celo_agent_id: 9058, arc_agent_id: null, stellar_agent_id: null,
    };
    __setSupabaseForTest(tableFake({ wallets: [row], explore_agents: [{ ...row, tx_count: 0 }] }, rec));
    const out = await searchWallets('agentkarma');
    expect(out).toHaveLength(1);
    expect(out[0].txCount).toBe(3); // the wallets row (real activity) wins
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
