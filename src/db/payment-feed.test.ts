/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from 'bun:test';
import * as db from './client';
import { decodePaymentsCursor, encodePaymentsCursor, PAYMENT_FEED_SETTLE_MS } from './client';

afterEach(() => db.__setSupabaseForTest(null));

const G = 'GC2NIKT6TWLMBZE4TU5ZMMDVV22URFIMJIZ4JYUC3QABBBWNGGZMAFGM';
const PAYER = 'GDDTQFQZK734EXIJE5LWU4G4YC5A6P5AHJ4UWVMV6WBFWT6BAAQQHV2V';
const NOW = new Date('2026-11-01T12:00:00Z');

function fake(rows: unknown[]) {
  const calls: { table: string; ops: unknown[][] } = { table: '', ops: [] };
  db.__setSupabaseForTest({ from(table: string) {
    calls.table = table;
    const b: Record<string, unknown> = {};
    for (const verb of ['select', 'eq', 'not', 'lt', 'order', 'or', 'limit']) b[verb] = (...a: unknown[]) => { calls.ops.push([verb, ...a]); return b; };
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ data: rows, error: null }));
    return b;
  } });
  return calls;
}

// Raw `transactions` rows as PostgREST returns them: amount as numeric text, ingest order differs from chain order.
const row = (i: number, o: Record<string, unknown> = {}) => ({ id: `00000000-0000-0000-0000-00000000000${i}`, tx_signature: `${900 + i}:0`,
  tx_hash: `hash${i}`, wallet_address: PAYER, counterparty: G, amount: '0.001000000000000000', timestamp: `2026-09-0${i}T00:00:00+00:00`,
  success: true, ingested_at: `2026-11-01T10:0${i}:00+00:00`, ...o });

describe('getPaymentFeed', () => {
  test('reads the raw table in ingest order, holding back rows younger than the settle margin', async () => {
    const calls = fake([row(1), row(2)]);
    const page = await db.getPaymentFeed('stellar-testnet', { limit: 5, now: NOW });
    expect(calls.table).toBe('transactions');
    expect(calls.ops).toContainEqual(['eq', 'chain', 'stellar-testnet']);
    expect(calls.ops).toContainEqual(['not', 'ingested_at', 'is', null]);
    expect(calls.ops).toContainEqual(['lt', 'ingested_at', new Date(NOW.getTime() - PAYMENT_FEED_SETTLE_MS).toISOString()]);
    expect(calls.ops).toContainEqual(['order', 'ingested_at', { ascending: true }]);
    expect(calls.ops).toContainEqual(['order', 'id', { ascending: true }]);
    expect(calls.ops).toContainEqual(['limit', 6]);
    expect(page.payments).toEqual([
      { id: '901:0', txHash: 'hash1', from: PAYER, to: G, amount: '0.0010000', timestamp: row(1).timestamp, success: true },
      { id: '902:0', txHash: 'hash2', from: PAYER, to: G, amount: '0.0010000', timestamp: row(2).timestamp, success: true },
    ]);
    expect(page.done).toBe(true);
    expect(decodePaymentsCursor(page.cursor!)).toEqual({ timestamp: row(2).ingested_at, id: row(2).id });
  });

  test('a full page is not done, and the next read continues strictly after the cursor', async () => {
    fake([row(1), row(2), row(3)]);
    const page = await db.getPaymentFeed('stellar-testnet', { limit: 2, now: NOW });
    expect(page.done).toBe(false);
    const c = decodePaymentsCursor(page.cursor!)!;
    const calls = fake([]);
    const next = await db.getPaymentFeed('stellar-testnet', { limit: 2, cursor: c, now: NOW });
    expect(calls.ops).toContainEqual(['or', `ingested_at.gt."${c.timestamp}",and(ingested_at.eq."${c.timestamp}",id.gt.${c.id})`]);
    // Nothing new: the caller's cursor comes back unchanged.
    expect(next).toEqual({ payments: [], cursor: encodePaymentsCursor(c), done: true });
  });

  test('keeps failed legs flagged, and moves past a row without a payee without listing it', async () => {
    fake([row(1, { success: false }), row(2, { counterparty: null })]);
    const page = await db.getPaymentFeed('stellar-testnet', { limit: 5, now: NOW });
    expect(page.payments.map((p) => [p.id, p.success])).toEqual([['901:0', false]]);
    expect(decodePaymentsCursor(page.cursor!)?.id).toBe(row(2).id);
  });
});
