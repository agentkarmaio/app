/// <reference types="bun-types" />
/**
 * insertTransactions / cursor helpers / claimWallet — row-mapping + onConflict
 * targets + chain-scoping. We stub the Supabase client (set via
 * __setSupabaseForTest) and capture the upsert/insert/update payload, asserting
 * `chain` survives and conflict targets / existence lookups are chain-scoped.
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import {
  __setSupabaseForTest, insertTransactions, upsertCursor, getCursor, claimWallet,
} from './client';
import type { Transaction } from './schema';

type Captured = { table: string; op: string; rows: unknown; opts: unknown };

function makeFakeSupabase(
  captured: Captured[],
  selectData: unknown[] = [],
  existingWallet: unknown = null,
) {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      builder.upsert = (rows: unknown, opts: unknown) => {
        captured.push({ table, op: 'upsert', rows, opts });
        return { select: async () => ({ data: selectData, error: null }) };
      };
      builder.insert = (rows: unknown) => {
        captured.push({ table, op: 'insert', rows, opts: null });
        return Promise.resolve({ error: null });
      };
      builder.update = (rows: unknown) => {
        captured.push({ table, op: 'update', rows, opts: null });
        // .update(...).eq(...).eq(...) chain resolves to { error: null }
        const chain: Record<string, unknown> = {};
        chain.eq = () => chain;
        chain.then = (resolve: (v: { error: null }) => void) => resolve({ error: null });
        return chain;
      };
      // chainable select().eq().single()/.maybeSingle() for getCursor + getWallet.
      // .single() is table-aware: getCursor reads indexer_cursors, getWallet reads
      // wallets (returns the injected existingWallet, defaulting to null → insert path).
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.single = async () => {
        if (table === 'indexer_cursors') {
          return {
            data: { chain: 'stellar', facilitator: 'CCW', last_signature: '7', last_slot: 7, updated_at: 'now' },
            error: null,
          };
        }
        // wallets: mimic PostgREST PGRST116 (no rows) when absent so getWallet returns null.
        return existingWallet
          ? { data: existingWallet, error: null }
          : { data: null, error: { code: 'PGRST116' } };
      };
      builder.maybeSingle = async () => ({ data: existingWallet, error: null });
      return builder;
    },
  };
}

describe('insertTransactions chain mapping', () => {
  let captured: Captured[];
  beforeEach(() => { captured = []; __setSupabaseForTest(makeFakeSupabase(captured, [{ id: '1' }])); });

  test('includes chain in the upserted row', async () => {
    const tx: Omit<Transaction, 'id'> = {
      chain: 'stellar', wallet_address: 'GABC', facilitator: 'GFAC',
      amount: 1, timestamp: '2026-06-06T00:00:00Z', success: true, tx_signature: 'deadbeef',
    };
    await insertTransactions([tx]);
    const rows = captured[0].rows as Array<Record<string, unknown>>;
    expect(rows[0].chain).toBe('stellar');
    expect(rows[0].tx_signature).toBe('deadbeef');
  });
});

describe('cursor helpers are chain-scoped', () => {
  let captured: Captured[];
  beforeEach(() => { captured = []; __setSupabaseForTest(makeFakeSupabase(captured)); });

  test('upsertCursor writes chain and conflicts on (chain,facilitator)', async () => {
    await upsertCursor('CCW', '7', 7, 'stellar');
    const row = captured[0].rows as Record<string, unknown>;
    expect(row.chain).toBe('stellar');
    expect((captured[0].opts as { onConflict: string }).onConflict).toBe('chain,facilitator');
  });

  test('getCursor filters by chain and returns the row', async () => {
    const c = await getCursor('CCW', 'stellar');
    expect(c?.chain).toBe('stellar');
  });
});

describe('claimWallet is chain-aware (C1)', () => {
  let captured: Captured[];

  test("a 'stellar' claim inserts chain:'stellar' when no wallet exists", async () => {
    captured = [];
    __setSupabaseForTest(makeFakeSupabase(captured, [], null));
    await claimWallet('GAGENT', 'Agent', null, null, null, null, 'stellar');
    const insertOp = captured.find((c) => c.op === 'insert');
    expect(insertOp).toBeDefined();
    const row = insertOp!.rows as Record<string, unknown>;
    expect(row.chain).toBe('stellar');
    expect(row.address).toBe('GAGENT');
  });

  test("a 'stellar' claim updates chain:'stellar' when the wallet exists", async () => {
    captured = [];
    __setSupabaseForTest(makeFakeSupabase(captured, [], { chain: 'stellar', address: 'GAGENT' }));
    await claimWallet('GAGENT', 'Agent', null, null, null, null, 'stellar');
    const updateOp = captured.find((c) => c.op === 'update');
    expect(updateOp).toBeDefined();
    const row = updateOp!.rows as Record<string, unknown>;
    expect(row.chain).toBe('stellar');
  });
});
