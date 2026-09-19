/// <reference types="bun-types" />
/**
 * The rescore queue must be chain-aware end to end.
 *
 * Reproduces the 2026-09-14 defect: `claimDirtyWallets` returned bare
 * addresses, so `rescoreOne` had no chain to pass and every read fell back to
 * `chain: Chain = DEFAULT_CHAIN` ('solana'). An arc wallet therefore queried
 * `chain='solana' AND wallet_address='0x…'`, got 0 rows, returned "skipped" —
 * and `claimDirtyWallets` had ALREADY cleared its dirty flag, so the wallet was
 * dropped from the queue having had nothing done. One live drain reported
 * `scored=3517 skipped=11650 errors=0` while arc's unscored count did not move.
 *
 * The bug lives purely in the COMPOSITION of two correct functions — a
 * reasonable back-compat default meeting a reasonable-looking call — so these
 * assert the chain that reaches the client layer, not a scoring outcome. A
 * fixture of the symptom would pass again the moment the default changed.
 *
 * Run: bun test src/scripts/rescore-dirty.test.ts
 */
import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import { __setSupabaseForTest } from '@/db/client';
import { drainOnce } from './rescore-dirty';

afterAll(() => { __setSupabaseForTest(null); });

const ARC_ADDR = '0x00000000000000000000000000000000000000a1';
const ARC_TX = {
  chain: 'arc', wallet_address: ARC_ADDR, facilitator: 'FAC', counterparty: 'PAYEE',
  amount: '1.5', timestamp: '2026-09-01T00:00:00Z', success: true, tx_signature: 'arc-1',
};

type Seen = { table: string; op: string; chain?: string; rows?: unknown };

/**
 * Records the `chain` filter of every read and the `chain` of every write.
 * `wallets` selects return one dirty arc row; `transactions` selects return the
 * arc tx ONLY when the query actually filtered on chain 'arc'.
 */
function makeChainRecordingFake(seen: Seen[], chain = 'arc') {
  return {
    from(table: string) {
      const state: { chain?: string } = {};
      const b: Record<string, unknown> = {};
      const rows = () => {
        if (table === 'wallets') return [{ chain, address: ARC_ADDR }];
        if (table === 'transactions') return state.chain === chain ? [{ ...ARC_TX, chain }] : [];
        return [];
      };
      b.select = () => { seen.push({ table, op: 'select', chain: state.chain }); return b; };
      b.eq = (col: string, val: unknown) => {
        if (col === 'chain') {
          state.chain = String(val);
          // PostgREST builders take the filter AFTER the verb
          // (`.update(row).eq('chain', c)`), so the call was already recorded
          // without a chain. Re-stamp the most recent one for this table.
          for (let i = seen.length - 1; i >= 0; i--) {
            if (seen[i].table === table && (seen[i].op === 'select' || seen[i].op === 'update')) {
              seen[i].chain = state.chain;
              break;
            }
          }
        }
        return b;
      };
      for (const m of ['not', 'neq', 'in', 'or', 'gt', 'gte', 'lt', 'is', 'order', 'limit']) b[m] = () => b;
      b.update = (r: unknown) => { seen.push({ table, op: 'update', chain: state.chain, rows: r }); return b; };
      b.insert = (r: unknown) => {
        seen.push({ table, op: 'insert', chain: state.chain, rows: r });
        return Promise.resolve({ error: null });
      };
      b.upsert = (r: unknown) => {
        seen.push({ table, op: 'upsert', chain: state.chain, rows: r });
        return { select: async () => ({ data: [], error: null }) };
      };
      b.single = async () => ({ data: null, error: { code: 'PGRST116' } });
      b.maybeSingle = async () => ({ data: null, error: null });
      b.then = (resolve: (v: { data: unknown[]; error: null; count: number }) => void) =>
        resolve({ data: rows(), error: null, count: rows().length });
      return b;
    },
  };
}

describe('rescore queue is chain-aware', () => {
  let seen: Seen[];
  beforeEach(() => { seen = []; __setSupabaseForTest(makeChainRecordingFake(seen)); });

  test('an arc wallet reads its transactions on chain arc, never solana', async () => {
    await drainOnce(10, 100);
    const txReads = seen.filter((s) => s.table === 'transactions' && s.op === 'select');
    expect(txReads.length).toBeGreaterThan(0);
    for (const r of txReads) expect(r.chain).toBe('arc');
  });

  test('nothing in the drain touches chain solana for an arc wallet', async () => {
    await drainOnce(10, 100);
    const solana = seen.filter((s) => s.chain === 'solana');
    expect(solana).toEqual([]);
  });

  test('the arc wallet is scored, not silently skipped', async () => {
    const r = await drainOnce(10, 100);
    expect(r.claimed).toBe(1);
    // The whole defect: claimed, skipped, de-queued, zero errors, zero effect.
    expect(r.skipped).toBe(0);
    expect(r.scored).toBe(1);
    expect(r.errors).toEqual([]);
  });

  test('the score write targets the arc wallet row', async () => {
    await drainOnce(10, 100);
    const walletWrite = seen.find((s) => s.table === 'wallets' && s.op === 'upsert');
    expect(walletWrite).toBeDefined();
    expect((walletWrite!.rows as { chain?: string }).chain).toBe('arc');
  });

  test('the score snapshot carries the chain — scores FKs (chain, wallet_address)', async () => {
    await drainOnce(10, 100);
    const snapshot = seen.find((s) => s.table === 'scores' && s.op === 'insert');
    expect(snapshot).toBeDefined();
    expect((snapshot!.rows as { chain?: string }).chain).toBe('arc');
  });

  test('clearing the dirty flag is chain-scoped', async () => {
    await drainOnce(10, 100);
    const clear = seen.find(
      (s) => s.table === 'wallets' && s.op === 'update' &&
        (s.rows as { scoring_dirty_at?: unknown })?.scoring_dirty_at === null,
    );
    expect(clear).toBeDefined();
    expect(clear!.chain).toBe('arc');
  });

  test('a mainnet row returned by the queue never reaches legacy scoring', async () => {
    __setSupabaseForTest(makeChainRecordingFake(seen, 'arc-mainnet'));
    const result = await drainOnce(10, 100);
    expect(result.scored).toBe(0);
    expect(seen.filter(row => row.table === 'transactions')).toEqual([]);
    expect(seen.filter(row => row.op === 'upsert' || row.op === 'insert')).toEqual([]);
  });
});
