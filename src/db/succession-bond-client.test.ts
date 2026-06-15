/// <reference types="bun-types" />
/**
 * DB helper tests for succession + bond projections: chain-scoping of the
 * lookups and the bond_underwriters → bond join remap. Uses the
 * __setSupabaseForTest seam (no live connection).
 *
 * Run: bun test src/db/succession-bond-client.test.ts
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import {
  __setSupabaseForTest, getSuccession, getBondsForAgent,
  getUnderwriterPositions, getReapableSuccessions, REAPABLE_STATUSES,
} from './client';

type Filter = { col: string; val: unknown };

interface Recorder {
  table: string;
  filters: Filter[];
  selected: string | null;
}

/**
 * Fake Supabase that records the table, chained `.eq()` filters, and select
 * string, then resolves the terminal call with `rows`. Supports the builder
 * shapes used by the helpers under test (maybeSingle / await on range / order).
 */
function makeFake(rows: unknown[], rec: Recorder[], count = rows.length) {
  return {
    from(table: string) {
      const r: Recorder = { table, filters: [], selected: null };
      rec.push(r);
      const builder: Record<string, unknown> = {};
      builder.select = (sel: string) => { r.selected = sel; return builder; };
      builder.eq = (col: string, val: unknown) => { r.filters.push({ col, val }); return builder; };
      builder.in = (col: string, val: unknown) => { r.filters.push({ col, val }); return builder; };
      builder.order = () => builder;
      builder.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
      builder.range = async () => ({ data: rows, error: null, count });
      // bare await (getBondsForAgent ends on .order()) — make builder thenable.
      builder.then = (resolve: (v: { data: unknown[]; error: null }) => void) =>
        resolve({ data: rows, error: null });
      return builder;
    },
  };
}

describe('getSuccession is chain-scoped', () => {
  let rec: Recorder[];
  beforeEach(() => { rec = []; });

  test('queries successions with (chain, agent_wallet)', async () => {
    __setSupabaseForTest(makeFake([{ chain: 'celo', agent_wallet: 'A', status: 'live' }], rec));
    const s = await getSuccession('A', 'celo');
    expect(s?.status).toBe('live');
    expect(rec[0].table).toBe('successions');
    expect(rec[0].filters).toContainEqual({ col: 'chain', val: 'celo' });
    expect(rec[0].filters).toContainEqual({ col: 'agent_wallet', val: 'A' });
  });

  test('returns null when absent', async () => {
    __setSupabaseForTest(makeFake([], rec));
    expect(await getSuccession('NONE', 'solana')).toBeNull();
  });
});

describe('getBondsForAgent is chain-scoped', () => {
  test('queries bonds with (chain, bonded_agent_wallet)', async () => {
    const rec: Recorder[] = [];
    __setSupabaseForTest(makeFake([{ id: 'b1', status: 'open' }], rec));
    const bonds = await getBondsForAgent('A', 'arc');
    expect(bonds).toHaveLength(1);
    expect(rec[0].table).toBe('bonds');
    expect(rec[0].filters).toContainEqual({ col: 'chain', val: 'arc' });
    expect(rec[0].filters).toContainEqual({ col: 'bonded_agent_wallet', val: 'A' });
  });
});

describe('getUnderwriterPositions remaps bonds(*) → bond', () => {
  test('flattens the joined bond and drops the `bonds` key', async () => {
    const rec: Recorder[] = [];
    __setSupabaseForTest(makeFake([
      {
        id: 'u1', bond_id: 'b1', chain: 'solana', underwriter_wallet: 'UW',
        stake_amount: 50, premium_earned: null, settled: true,
        created_at: '2026-06-10T00:00:00Z',
        bonds: { id: 'b1', status: 'resolved_success', amount: 100 },
      },
    ], rec));
    const positions = await getUnderwriterPositions('UW', 'solana');
    expect(positions).toHaveLength(1);
    expect(positions[0].bond?.status).toBe('resolved_success');
    expect((positions[0] as unknown as Record<string, unknown>).bonds).toBeUndefined();
    expect(rec[0].selected).toBe('*, bonds(*)');
    expect(rec[0].filters).toContainEqual({ col: 'underwriter_wallet', val: 'UW' });
  });

  test('null join → bond null', async () => {
    const rec: Recorder[] = [];
    __setSupabaseForTest(makeFake([
      {
        id: 'u1', bond_id: 'b1', chain: 'solana', underwriter_wallet: 'UW',
        stake_amount: 50, premium_earned: null, settled: false,
        created_at: '2026-06-10T00:00:00Z', bonds: null,
      },
    ], rec));
    const positions = await getUnderwriterPositions('UW', 'solana');
    expect(positions[0].bond).toBeNull();
  });
});

describe('getReapableSuccessions filters to the reapable status set', () => {
  test('default uses REAPABLE_STATUSES and returns total', async () => {
    const rec: Recorder[] = [];
    __setSupabaseForTest(makeFake(
      [{ chain: 'solana', agent_wallet: 'A', status: 'lapsed' }], rec, 7,
    ));
    const page = await getReapableSuccessions(25, 0);
    expect(page.total).toBe(7);
    expect(page.successions).toHaveLength(1);
    expect(rec[0].filters).toContainEqual({ col: 'status', val: REAPABLE_STATUSES });
  });

  test('chain filter is applied when provided', async () => {
    const rec: Recorder[] = [];
    __setSupabaseForTest(makeFake([], rec, 0));
    await getReapableSuccessions(10, 0, { chain: 'celo' });
    expect(rec[0].filters).toContainEqual({ col: 'chain', val: 'celo' });
  });
});
