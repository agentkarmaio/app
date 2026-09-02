/// <reference types="bun-types" />
/**
 * resolveForChain — the shared MCP `get_karma` / A2A entry point. A checksummed
 * EVM address must canonicalize BEFORE the (chain,address) row lookup, and the
 * enrichment blocks must ride along on the resolved union. Fake Supabase; the
 * wallets row exists only under the lowercase key and carries no agentId, so
 * no chain RPC is attempted.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { __setSupabaseForTest } from '@/db/client';
import { resolveForChain, fullKarmaJson } from './route';

const CHECKSUMMED = '0x68961aC3376fa6c2aa20689307Be57f107031B31';
const LOWER = CHECKSUMMED.toLowerCase();
const ROW = {
  chain: 'celo', address: LOWER, provider_score: 88, consumer_score: null, trust_tier: 'Very Good',
  confidence_badge: 'declared', claimed: false, celo_agent_id: null, arc_agent_id: null, rank_score: 61.6, tx_count: 0,
};

function fakeSupabase(filters: string[]) {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      let addressArg: string | null = null;
      for (const m of ['select', 'in', 'or', 'order', 'limit']) b[m] = () => b;
      b.eq = (col: string, v: unknown) => {
        filters.push(`${table}.${col}=${String(v)}`);
        if (col === 'address') addressArg = String(v);
        return b;
      };
      const rowsFor = () => (table === 'wallets' && addressArg === LOWER ? [ROW] : []);
      b.single = async () => {
        const rows = rowsFor();
        return rows.length ? { data: rows[0], error: null } : { data: null, error: { code: 'PGRST116' } };
      };
      b.maybeSingle = async () => ({ data: rowsFor()[0] ?? null, error: null });
      b.then = (resolve: (v: unknown) => void) => resolve({ data: rowsFor(), error: null, count: rowsFor().length });
      return b;
    },
  };
}

afterEach(() => __setSupabaseForTest(null));

describe('resolveForChain boundary normalization', () => {
  test('checksummed EVM + chain hint resolves the lowercase celo row and carries enrichment', async () => {
    const filters: string[] = [];
    __setSupabaseForTest(fakeSupabase(filters));

    const resolved = await resolveForChain(CHECKSUMMED, 'celo');
    expect(resolved?.kind).toBe('evm');
    expect(filters.some((f) => f.includes(CHECKSUMMED))).toBe(false);

    const json = fullKarmaJson(resolved!, LOWER) as Record<string, unknown>;
    expect(json.chain).toBe('celo');
    expect(json.address).toBe(LOWER);
    expect(json.rankScore).toBe(61.6);
    expect(Array.isArray(json.explain)).toBe(true);
    // Two faces + badge untouched by the additive blocks.
    expect((json.provider as { score: number }).score).toBe(88);
    expect((json.consumer as { score: null }).score).toBeNull();
    expect(json.confidenceBadge).toBe('declared');
  }, 20_000);
});
