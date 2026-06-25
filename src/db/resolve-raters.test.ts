/// <reference types="bun-types" />
/**
 * resolveRaters — maps ERC-8004 feedback `client` addresses to a name + agent_id
 * so the feedback list can show who attested instead of a bare hex string.
 * Stubs Supabase (via __setSupabaseForTest); each `.in()` resolves per-table.
 * Asserts: agent_wallet → agent_id + registration name; a claimed display_name
 * overrides the registry name but keeps the agent_id; nameless wallet rows are
 * skipped; addresses are lowercased on both the key and the match.
 */
import { describe, expect, test, afterAll } from 'bun:test';
import { __setSupabaseForTest, resolveRaters } from './client';

afterAll(() => { __setSupabaseForTest(null); });

type TableData = Record<string, { data?: unknown[]; error?: unknown }>;

function makeFakeSupabase(byTable: TableData) {
  return {
    from(table: string) {
      const result = byTable[table] ?? { data: [], error: null };
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      // The query chain ends on .in(); resolve the awaited PostgREST shape here.
      builder.in = () => Promise.resolve({ data: result.data ?? [], error: result.error ?? null });
      return builder;
    },
  };
}

describe('resolveRaters', () => {
  test('registry agent_wallet match yields agent_id + registration name', async () => {
    __setSupabaseForTest(makeFakeSupabase({
      erc8004_agents: { data: [{ agent_id: 42, agent_wallet: '0xaaa', registration: { name: 'Indexer Bot' } }] },
      wallets: { data: [] },
    }));
    const map = await resolveRaters(['0xAAA'], 'celo');
    expect(map.get('0xaaa')).toEqual({ name: 'Indexer Bot', agentId: 42 });
  });

  test('claimed display_name overrides registry name but keeps the agent_id', async () => {
    __setSupabaseForTest(makeFakeSupabase({
      erc8004_agents: { data: [{ agent_id: 7, agent_wallet: '0xbbb', registration: { name: 'On-chain Name' } }] },
      wallets: { data: [{ address: '0xbbb', display_name: 'Curated Name' }] },
    }));
    const map = await resolveRaters(['0xbbb'], 'celo');
    expect(map.get('0xbbb')).toEqual({ name: 'Curated Name', agentId: 7 });
  });

  test('a wallet row with no display_name adds no signal (skipped)', async () => {
    __setSupabaseForTest(makeFakeSupabase({
      erc8004_agents: { data: [] },
      wallets: { data: [{ address: '0xccc', display_name: null }] },
    }));
    const map = await resolveRaters(['0xccc'], 'celo');
    expect(map.has('0xccc')).toBe(false);
  });

  test('unknown rater is absent from the map', async () => {
    __setSupabaseForTest(makeFakeSupabase({ erc8004_agents: { data: [] }, wallets: { data: [] } }));
    const map = await resolveRaters(['0xdead'], 'arc');
    expect(map.has('0xdead')).toBe(false);
  });

  test('keys + matches are lowercased (checksummed input resolves)', async () => {
    __setSupabaseForTest(makeFakeSupabase({
      erc8004_agents: { data: [{ agent_id: 1, agent_wallet: '0xabcdef', registration: null }] },
      wallets: { data: [] },
    }));
    const map = await resolveRaters(['0xABCDEF'], 'celo');
    expect(map.get('0xabcdef')).toEqual({ name: null, agentId: 1 });
    expect(map.get('0xABCDEF')).toBeUndefined();
  });

  test('empty input returns an empty map without querying', async () => {
    // No fake set → if it queried, .from would be undefined and throw.
    __setSupabaseForTest(null);
    const map = await resolveRaters([], 'celo');
    expect(map.size).toBe(0);
  });
});
