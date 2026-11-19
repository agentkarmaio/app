import { describe, expect, test } from 'bun:test';
import {
  buildStellarOwnerGroups,
  computeStellarReceiptMetrics,
  type StellarReceiptRow,
} from './stellar-receipt-metrics';

const W = 'GWALLET';
const row = (
  tx: string, from: string, to: string | null, timestamp = '2026-08-17T00:00:00Z',
): StellarReceiptRow => ({ tx_signature: tx, wallet_address: from, counterparty: to, timestamp });

describe('computeStellarReceiptMetrics', () => {
  test('counts inbound receipts — the payee face the old path never read', () => {
    const m = computeStellarReceiptMetrics(W, [
      row('t1', 'GPAYER1', W, '2026-08-01T00:00:00Z'),
      row('t2', 'GPAYER2', W, '2026-08-03T00:00:00Z'),
    ]);
    expect(m).toEqual({ txCount: 2, lastSeen: '2026-08-03T00:00:00.000Z', diversity: 0.2 });
  });

  test('counts outbound payments', () => {
    const m = computeStellarReceiptMetrics(W, [row('t1', W, 'GPAYEE', '2026-08-02T00:00:00Z')]);
    expect(m).toEqual({ txCount: 1, lastSeen: '2026-08-02T00:00:00.000Z', diversity: 0.1 });
  });

  test('a counterparty seen in both directions counts once for diversity', () => {
    const m = computeStellarReceiptMetrics(W, [
      row('t1', 'GX', W), row('t2', W, 'GX'), row('t3', 'GX', W),
    ]);
    expect(m.txCount).toBe(3);
    expect(m.diversity).toBe(0.1);
  });

  test('dedupes by transaction identity, never by row', () => {
    const m = computeStellarReceiptMetrics(W, [row('t1', 'GX', W), row('t1', 'GX', W)]);
    expect(m.txCount).toBe(1);
  });

  test('ignores rows that do not involve the wallet', () => {
    const m = computeStellarReceiptMetrics(W, [row('t1', 'GA', 'GB')]);
    expect(m).toEqual({ txCount: 0, lastSeen: null, diversity: null });
  });

  test('outbound with unknown payee counts activity but not breadth', () => {
    const m = computeStellarReceiptMetrics(W, [row('t1', W, null)]);
    expect(m).toEqual({ txCount: 1, lastSeen: '2026-08-17T00:00:00.000Z', diversity: null });
  });

  test('same-owner counterparties are excluded from activity and breadth', () => {
    const m = computeStellarReceiptMetrics(W, [
      row('t1', 'GSIBLING', W), row('t2', 'GCUSTOMER', W),
    ], new Set([W, 'GSIBLING']));
    expect(m).toEqual({ txCount: 1, lastSeen: '2026-08-17T00:00:00.000Z', diversity: 0.1 });
  });

  test('a wallet whose only activity is same-owner reports none', () => {
    const m = computeStellarReceiptMetrics(W, [row('t1', 'GSIBLING', W)], new Set([W, 'GSIBLING']));
    expect(m).toEqual({ txCount: 0, lastSeen: null, diversity: null });
  });

  test('diversity saturates at the shared normalization cap', () => {
    const rows = Array.from({ length: 15 }, (_, i) => row(`t${i}`, `GP${i}`, W));
    expect(computeStellarReceiptMetrics(W, rows).diversity).toBe(1);
  });

  test('empty input', () => {
    expect(computeStellarReceiptMetrics(W, [])).toEqual({ txCount: 0, lastSeen: null, diversity: null });
  });

  test('rejects an unparseable timestamp instead of inventing liveness', () => {
    expect(() => computeStellarReceiptMetrics(W, [row('t1', 'GX', W, 'not-a-date')]))
      .toThrow('stellar_receipt_timestamp_invalid');
  });
});

describe('buildStellarOwnerGroups', () => {
  test('groups every address an owner controls, including its agent wallets', () => {
    const groups = buildStellarOwnerGroups([
      { owner: 'GOWNER', agent_wallet: null },
      { owner: 'GOWNER', agent_wallet: 'GAGENT1' },
      { owner: 'GOTHER', agent_wallet: null },
    ]);
    expect([...(groups.get('GAGENT1') ?? [])].sort()).toEqual(['GAGENT1', 'GOWNER']);
    expect([...(groups.get('GOWNER') ?? [])].sort()).toEqual(['GAGENT1', 'GOWNER']);
    expect([...(groups.get('GOTHER') ?? [])]).toEqual(['GOTHER']);
  });

  test('control chains of any depth collapse into one group (A owns X, X owns Y)', () => {
    const groups = buildStellarOwnerGroups([
      { owner: 'GA', agent_wallet: 'GX' },
      { owner: 'GX', agent_wallet: 'GY' },
    ]);
    for (const a of ['GA', 'GX', 'GY']) {
      expect([...(groups.get(a) ?? [])].sort()).toEqual(['GA', 'GX', 'GY']);
    }
  });

  test('a shared payer across different owners is not a sibling', () => {
    const groups = buildStellarOwnerGroups([
      { owner: 'GOWNER_A', agent_wallet: null },
      { owner: 'GOWNER_B', agent_wallet: null },
    ]);
    expect(groups.get('GOWNER_A')?.has('GOWNER_B')).toBe(false);
  });
});
