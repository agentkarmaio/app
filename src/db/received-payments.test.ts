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

const row = (i: number) => ({ id: `00000000-0000-0000-0000-00000000000${i}`, tx_signature: `op${i}:0`, tx_hash: `hash${i}`,
  direction: 'received', counterparty: G, wallet_address: PAYER, amount: '0.001000000000000000', timestamp: `2026-10-1${i}T00:00:00+00:00`, success: true,
  counted: true, excluded_reason: null });

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

describe('getAgentPayments', () => {
  test('reads inbound rows for one chain + agent, newest first, with a stable tiebreak', async () => {
    const calls = fake([row(3), row(2)]);
    const page = await db.getAgentPayments('stellar-testnet', 7, { limit: 5 });
    // The classified view, not the raw table: it carries counted / excluded_reason.
    expect(calls.table).toBe('stellar_testnet_payments');
    expect(calls.ops).toContainEqual(['eq', 'chain', 'stellar-testnet']);
    expect(calls.ops).toContainEqual(['eq', 'agent_id', 7]);
    // Default is inbound only: the original behaviour for existing readers.
    expect(calls.ops).toContainEqual(['eq', 'direction', 'received']);
    expect(calls.ops).toContainEqual(['order', 'timestamp', { ascending: false }]);
    expect(calls.ops).toContainEqual(['order', 'id', { ascending: false }]);
    expect(calls.ops).toContainEqual(['limit', 6]);
    expect(calls.ops.find((o) => o[0] === 'select')?.[1]).toContain('tx_hash');
    expect(calls.ops.find((o) => o[0] === 'select')?.[1]).toContain('excluded_reason');
    expect(page.payments).toEqual([
      { direction: 'received', to: G, id: 'op3:0', txHash: 'hash3', from: PAYER, amount: '0.0010000', timestamp: row(3).timestamp, success: true, counted: true, excludedReason: null },
      { direction: 'received', to: G, id: 'op2:0', txHash: 'hash2', from: PAYER, amount: '0.0010000', timestamp: row(2).timestamp, success: true, counted: true, excludedReason: null },
    ]);
    expect(page.nextCursor).toBeNull();
  });

  test('a full page returns a cursor that continues strictly after the last row', async () => {
    fake([row(3), row(2), row(1)]);
    const page = await db.getAgentPayments('stellar-testnet', 7, { limit: 2 });
    expect(page.payments.map(p => p.txHash)).toEqual(['hash3', 'hash2']);
    expect(decodePaymentsCursor(page.nextCursor!)).toEqual({ timestamp: row(2).timestamp, id: row(2).id });

    const calls = fake([row(1)]);
    await db.getAgentPayments('stellar-testnet', 7, { limit: 2, cursor: decodePaymentsCursor(page.nextCursor!)! });
    const ts = row(2).timestamp;
    expect(calls.ops).toContainEqual(['or', `timestamp.lt."${ts}",and(timestamp.eq."${ts}",id.lt.${row(2).id})`]);
  });
});

describe('excluded payers are flagged, not hidden', () => {
  test('a row excluded by the view keeps its place in the page with counted:false and its reason', async () => {
    fake([
      { ...row(2), counted: false, excluded_reason: 'owner' },
      { ...row(1), counted: false, excluded_reason: 'listed' },
      { ...row(0), success: false, counted: false, excluded_reason: null },
    ]);
    const page = await db.getAgentPayments('stellar-testnet', 7, { limit: 5 });
    expect(page.payments.map((p) => [p.id, p.counted, p.excludedReason])).toEqual([
      ['op2:0', false, 'owner'], ['op1:0', false, 'listed'], ['op0:0', false, null],
    ]);
  });
  test('an unknown reason from the database is refused rather than passed through', async () => {
    fake([{ ...row(1), counted: false, excluded_reason: 'whatever' }]);
    await expect(db.getAgentPayments('stellar-testnet', 7, { limit: 5 })).rejects.toThrow();
  });
});

describe('multi-leg transactions', () => {
  const leg = (idx: number, amount: string) => ({ id: `00000000-0000-0000-0000-00000000010${idx}`,
    tx_signature: `9000:${idx}`, tx_hash: 'samehash', direction: 'received', counterparty: G, wallet_address: PAYER, amount,
    timestamp: '2026-10-14T00:00:00+00:00', success: true, counted: true, excluded_reason: null });

  test('each leg of one transaction is its own payment with a unique id', async () => {
    fake([leg(1, '0.800000000000000000'), leg(0, '0.200000000000000000')]);
    const page = await db.getAgentPayments('stellar-testnet', 7, { limit: 5 });
    expect(page.payments.map((p) => [p.id, p.txHash, p.amount])).toEqual([
      ['9000:1', 'samehash', '0.8000000'],
      ['9000:0', 'samehash', '0.2000000'],
    ]);
  });

  test('paging between legs that share a timestamp neither skips nor repeats a leg', async () => {
    fake([leg(1, '0.8'), leg(0, '0.2')]);
    const page = await db.getAgentPayments('stellar-testnet', 7, { limit: 1 });
    expect(page.payments.map((p) => p.id)).toEqual(['9000:1']);
    // The cursor is (timestamp, row uuid): unique per leg, so the next page
    // starts strictly after leg 1 and still sees leg 0.
    expect(decodePaymentsCursor(page.nextCursor!)).toEqual({ timestamp: leg(1, '0').timestamp, id: leg(1, '0').id });
  });

  test('a legacy row without tx_hash falls back to tx_signature', async () => {
    fake([{ ...row(1), tx_hash: null, tx_signature: 'legacyhash' }]);
    const page = await db.getAgentPayments('stellar-testnet', 7, { limit: 5 });
    expect(page.payments[0]).toMatchObject({ id: 'legacyhash', txHash: 'legacyhash' });
  });
});

describe('sent direction', () => {
  const sent = (i: number) => ({ ...row(i), direction: 'sent', wallet_address: G, counterparty: PAYER,
    amount: '2.500000000000000000', counted: true, excluded_reason: null });

  test('direction=sent filters to outbound legs and maps the payee to `to`', async () => {
    const calls = fake([sent(2), sent(1)]);
    const page = await db.getAgentPayments('stellar-testnet', 7, { limit: 5, direction: 'sent' });
    expect(calls.ops).toContainEqual(['eq', 'direction', 'sent']);
    expect(page.payments).toEqual([
      { direction: 'sent', to: PAYER, id: 'op2:0', txHash: 'hash2', from: G, amount: '2.5000000', timestamp: row(2).timestamp, success: true, counted: true, excludedReason: null },
      { direction: 'sent', to: PAYER, id: 'op1:0', txHash: 'hash1', from: G, amount: '2.5000000', timestamp: row(1).timestamp, success: true, counted: true, excludedReason: null },
    ]);
  });

  test('direction=all applies no direction filter and keeps both kinds in one keyset-ordered page', async () => {
    const calls = fake([sent(3), row(2), sent(1)]);
    const page = await db.getAgentPayments('stellar-testnet', 7, { limit: 5, direction: 'all' });
    expect(calls.ops.some((o) => o[0] === 'eq' && o[1] === 'direction')).toBe(false);
    expect(page.payments.map((p) => [p.id, p.direction])).toEqual([['op3:0', 'sent'], ['op2:0', 'received'], ['op1:0', 'sent']]);
  });

  test('a failed sent leg is not counted and has no reason', async () => {
    fake([{ ...sent(1), success: false, counted: false }]);
    const page = await db.getAgentPayments('stellar-testnet', 7, { limit: 5, direction: 'sent' });
    expect(page.payments[0]).toMatchObject({ success: false, counted: false, excludedReason: null });
  });
});
