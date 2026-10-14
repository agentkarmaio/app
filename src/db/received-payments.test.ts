/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from 'bun:test';
import * as db from './client';
import { decodePaymentsCursor, encodePaymentsCursor, formatUsdc7 } from './client';

afterEach(() => db.__setSupabaseForTest(null));

const G = 'GC2NIKT6TWLMBZE4TU5ZMMDVV22URFIMJIZ4JYUC3QABBBWNGGZMAFGM';
const PAYER = 'GDDTQFQZK734EXIJE5LWU4G4YC5A6P5AHJ4UWVMV6WBFWT6BAAQQHV2V';

function fake(rows: unknown[]) {
  const calls: { table: string; ops: unknown[][] } = { table: '', ops: [] };
  db.__setSupabaseForTest({ from(table: string) {
    calls.table = table;
    const b: Record<string, unknown> = {};
    for (const verb of ['select', 'eq', 'order', 'or', 'limit']) b[verb] = (...a: unknown[]) => { calls.ops.push([verb, ...a]); return b; };
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ data: rows, error: null }));
    return b;
  } });
  return calls;
}

const row = (i: number) => ({ id: `00000000-0000-0000-0000-00000000000${i}`, tx_signature: `hash${i}`,
  wallet_address: PAYER, amount: '0.001000000000000000', timestamp: `2026-10-1${i}T00:00:00+00:00`, success: true });

describe('formatUsdc7', () => {
  test('renders numeric text as a fixed 7-decimal USDC string', () => {
    expect(formatUsdc7('0.001000000000000000')).toBe('0.0010000');
    expect(formatUsdc7('146.3898')).toBe('146.3898000');
    expect(formatUsdc7('5')).toBe('5.0000000');
    expect(formatUsdc7('0.0000001')).toBe('0.0000001');
  });
  test('refuses precision Stellar USDC cannot carry instead of silently truncating', () => {
    expect(() => formatUsdc7('0.00000001')).toThrow();
    expect(() => formatUsdc7('abc')).toThrow();
  });
});

describe('payments cursor', () => {
  test('round-trips and rejects garbage', () => {
    const c = encodePaymentsCursor({ timestamp: '2026-10-14T00:00:00+00:00', id: row(1).id });
    expect(decodePaymentsCursor(c)).toEqual({ timestamp: '2026-10-14T00:00:00+00:00', id: row(1).id });
    expect(decodePaymentsCursor('not-a-cursor')).toBeNull();
    expect(decodePaymentsCursor(Buffer.from('x|y').toString('base64url'))).toBeNull();
  });
});

describe('getReceivedPayments', () => {
  test('reads inbound rows for one chain + payee, newest first, with a stable tiebreak', async () => {
    const calls = fake([row(3), row(2)]);
    const page = await db.getReceivedPayments('stellar-testnet', G, { limit: 5 });
    expect(calls.table).toBe('transactions');
    expect(calls.ops).toContainEqual(['eq', 'chain', 'stellar-testnet']);
    expect(calls.ops).toContainEqual(['eq', 'counterparty', G]);
    expect(calls.ops).toContainEqual(['order', 'timestamp', { ascending: false }]);
    expect(calls.ops).toContainEqual(['order', 'id', { ascending: false }]);
    expect(calls.ops).toContainEqual(['limit', 6]);
    expect(page.payments).toEqual([
      { txHash: 'hash3', from: PAYER, amount: '0.0010000', timestamp: row(3).timestamp, success: true },
      { txHash: 'hash2', from: PAYER, amount: '0.0010000', timestamp: row(2).timestamp, success: true },
    ]);
    expect(page.nextCursor).toBeNull();
  });

  test('a full page returns a cursor that continues strictly after the last row', async () => {
    fake([row(3), row(2), row(1)]);
    const page = await db.getReceivedPayments('stellar-testnet', G, { limit: 2 });
    expect(page.payments.map(p => p.txHash)).toEqual(['hash3', 'hash2']);
    expect(decodePaymentsCursor(page.nextCursor!)).toEqual({ timestamp: row(2).timestamp, id: row(2).id });

    const calls = fake([row(1)]);
    await db.getReceivedPayments('stellar-testnet', G, { limit: 2, cursor: decodePaymentsCursor(page.nextCursor!)! });
    const ts = row(2).timestamp;
    expect(calls.ops).toContainEqual(['or', `timestamp.lt."${ts}",and(timestamp.eq."${ts}",id.lt.${row(2).id})`]);
  });
});
