import { afterEach, expect, test } from 'bun:test';
import * as db from './client';

afterEach(() => db.__setSupabaseForTest(null));

type Call = { table: string; ops: Array<[string, unknown[]]> };

function fakeClient(responder: (call: Call) => { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  db.__setSupabaseForTest({
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const b: Record<string, unknown> = {};
      for (const op of ['select', 'eq', 'gt', 'order', 'limit', 'update']) {
        b[op] = (...args: unknown[]) => { call.ops.push([op, args]); return b; };
      }
      b.then = (resolve: (v: unknown) => void) => resolve(responder(call));
      return b;
    },
  });
  return calls;
}

test('getStellarReceiptRows pages by id and reads only chain stellar', async () => {
  const page1 = Array.from({ length: 1000 }, (_, i) => ({
    id: String(i + 1).padStart(6, '0'), tx_signature: `t${i}`, wallet_address: 'GA', counterparty: 'GB', timestamp: '2026-08-17T00:00:00Z',
  }));
  const calls = fakeClient((c) => {
    const after = c.ops.find(([op]) => op === 'gt');
    return { data: after ? [{ ...page1[0], id: '999999', tx_signature: 'last' }] : page1, error: null };
  });
  const rows = await db.getStellarReceiptRows();
  expect(rows).toHaveLength(1001);
  expect(rows[0]).not.toHaveProperty('id');
  expect(calls[1].ops).toContainEqual(['gt', ['id', '001000']]);
  for (const c of calls) {
    expect(c.table).toBe('transactions');
    expect(c.ops).toContainEqual(['eq', ['chain', 'stellar']]);
  }
});

test('updateStellarDisplayMetrics refuses a write that matched no wallet row', async () => {
  fakeClient(() => ({ data: [], error: null }));
  await expect(db.updateStellarDisplayMetrics('GMISSING', {
    tx_count: 1, last_seen: null, metric_diversity: null, metric_success_rate: null,
  })).rejects.toThrow('stellar_display_update_matched_0');
});

test('updateStellarDisplayMetrics writes only display columns, scoped to stellar', async () => {
  const calls = fakeClient(() => ({ data: [{ address: 'GA' }], error: null }));
  await db.updateStellarDisplayMetrics('GA', { tx_count: 2, last_seen: '2026-08-17T00:00:00.000Z', metric_diversity: 0.2, metric_success_rate: null });
  const update = calls[0].ops.find(([op]) => op === 'update')![1][0] as Record<string, unknown>;
  expect(Object.keys(update).sort()).toEqual(['last_seen', 'metric_diversity', 'metric_success_rate', 'tx_count', 'updated_at']);
  expect(calls[0].ops).toContainEqual(['eq', ['chain', 'stellar']]);
  expect(calls[0].ops).toContainEqual(['eq', ['address', 'GA']]);
});
