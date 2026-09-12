import { describe, expect, test } from 'bun:test';
import { formatUnits } from 'viem';
import type { SignalEvent } from '@/db/schema';
import { ARC_MAINNET_TRANSFER_EMITTER } from '@/config/arc-mainnet';
import { collectArcMainnetReceipts, computeArcMainnetReceiptScore } from './arc-mainnet-receipts';

const wallet = `0x${'1'.repeat(40)}`;
const payer = `0x${'2'.repeat(40)}`;
const other = `0x${'3'.repeat(40)}`;
const now = new Date('2026-09-12T12:00:00Z');
function receipt(face: 'provider' | 'consumer', index = 1, overrides: Partial<SignalEvent> = {}): SignalEvent {
  const hash = `0x${index.toString(16).padStart(64, '0')}`;
  return {
    id: String(index), chain: 'arc-mainnet', agent_wallet: wallet,
    kind: 'usdc_transfer_settled', tier: 2, face, weight: 0.6, value: 1,
    tx_ref: `${hash}:0`, signed_by: null,
    observed_at: now.toISOString(), created_at: now.toISOString(),
    payload: { source: 'arc_native_usdc_transfer', rawTxHash: hash, logIndex: 0, rawAmount: '1000000000000000001',
      amountDecimal: '1.000000000000000001', amount: 1, decimals: 18,
      emitter: ARC_MAINNET_TRANSFER_EMITTER, counterparty: payer },
    ...overrides,
  };
}
const compute = (events: SignalEvent[]) => collectArcMainnetReceipts(wallet, events, { now });

describe('Arc mainnet transfer provenance', () => {
  test('sender and receiver observations retain exact precision and event identity', () => {
    for (const face of ['provider', 'consumer'] as const) {
      const row = receipt(face);
      expect(compute([row]).observations).toEqual([{
        eventKey: row.tx_ref!, rawTxHash: String(row.payload!.rawTxHash), logIndex: 0,
        face, counterparty: payer, rawAmount: '1000000000000000001',
        amountDecimal: '1.000000000000000001', timestamp: now.toISOString(),
      }]);
    }
  });
  test('duplicate replay and order do not alter observations', () => {
    const row = receipt('provider');
    expect(compute([row, { ...row, id: 'duplicate' }])).toEqual(compute([row]));
  });
  test('conflicting copies of one event fail closed regardless of order', () => {
    const row = receipt('provider');
    const conflict = { ...row, payload: { ...row.payload, counterparty: other } };
    expect(compute([row, conflict]).observations).toEqual([]);
    expect(compute([conflict, row])).toEqual(compute([row, conflict]));
  });
  test('different log indices cannot give one transaction conflicting timestamps', () => {
    const row = receipt('provider');
    const conflict = { ...row, observed_at: '2026-01-01T00:00:00Z',
      tx_ref: `${row.payload!.rawTxHash}:1`, payload: { ...row.payload, logIndex: 1 } };
    expect(compute([row, conflict]).observations).toEqual([]);
    expect(compute([conflict, row])).toEqual(compute([row, conflict]));
  });
  test('bad provenance, other networks, self/mint/burn, and malformed amounts fail closed', () => {
    const valid = receipt('provider');
    const mutations: Partial<SignalEvent>[] = [
      { chain: 'arc' }, { tier: 1 }, { agent_wallet: other }, { kind: 'manifest' },
      { face: 'surety' as SignalEvent['face'] }, { tx_ref: 'not-a-receipt' },
      { observed_at: 'invalid' }, { observed_at: '2099-01-01T00:00:00Z' },
      { payload: { ...valid.payload, emitter: other } },
      { payload: { ...valid.payload, source: 'erc20' } },
      { payload: { ...valid.payload, decimals: 6 } },
      { payload: { ...valid.payload, rawAmount: '0' } },
      { payload: { ...valid.payload, rawAmount: '-1' } },
      { payload: { ...valid.payload, rawAmount: (10n ** 38n).toString() } },
      { payload: { ...valid.payload, rawAmount: '1.2' } },
      { payload: { ...valid.payload, amountDecimal: '2' } },
      { payload: { ...valid.payload, counterparty: wallet } },
      { payload: { ...valid.payload, counterparty: `0x${'0'.repeat(40)}` } },
      { signed_by: other },
    ];
    for (const mutation of mutations) {
      const result = compute([{ ...valid, ...mutation }]);
      expect(result.observations).toEqual([]);
      expect(result.invalid).toBe(1);
    }
  });
  test('sub-micro amounts retain lossless evidence', () => {
    const small = receipt('provider');
    small.payload = { ...small.payload, rawAmount: '1', amountDecimal: formatUnits(1n, 18), amount: 1e-18 };
    expect(compute([small]).observations[0]).toMatchObject({ rawAmount: '1', amountDecimal: '0.000000000000000001' });
  });
});

const score = (events: SignalEvent[]) => computeArcMainnetReceiptScore(wallet, events, { now });
describe('Arc mainnet behavior score', () => {
  test('one payment credits only its observed face at the approved formula', () => {
    for (const face of ['provider', 'consumer'] as const) {
      const result = score([receipt(face)]);
      expect(result[face]).toMatchObject({ score: 5.06, hasSignal: true, trustTier: 'Unrated', confidenceBadge: 'behavior-inferred', tierAggregates: { tier1: null } });
      expect(result[face === 'provider' ? 'consumer' : 'provider'].hasSignal).toBe(false);
      expect(result.txCount).toBe(1);
    }
    expect(score([]).provider.hasSignal).toBe(false);
  });
  test('duplicates and multi-log transactions cannot inflate activity or breadth', () => {
    const row = receipt('provider');
    const replay = score([row, { ...row, id: 'duplicate' }]);
    expect(replay.provider).toEqual(score([row]).provider);
    expect(replay.txCount).toBe(1);
    expect(replay.evidence.received).toBe(1);
    const logs = Array.from({ length: 100 }, (_, i) => ({ ...row, id: String(i),
      tx_ref: `${row.payload!.rawTxHash}:${i}`, payload: { ...row.payload, logIndex: i,
        counterparty: `0x${(i + 10).toString(16).padStart(40, '0')}` } }));
    expect(score(logs).provider.score).toBe(5.06);
    expect(score(logs).txCount).toBe(1);
    expect(score(logs).provider.trustTier).toBe('Unrated');
  });
  test('independent inbound and outbound observations supply both faces', () => {
    const sent = receipt('consumer', 2);
    sent.payload = { ...sent.payload, counterparty: other };
    expect(score([receipt('provider'), sent]).provider.hasSignal).toBe(true);
    expect(score([receipt('provider'), sent]).consumer.hasSignal).toBe(true);
  });
  test('equal reciprocal loops retain receipts but earn no score', () => {
    const result = score([receipt('provider'), receipt('consumer', 2)]);
    expect(result.provider.hasSignal).toBe(false);
    expect(result.consumer.hasSignal).toBe(false);
    expect(result.provider.score).toBe(0);
    expect(result.txCount).toBe(2);
    expect(result.evidence.matchedReciprocalRawAmount).toBe('1000000000000000001');
  });
  test('reverse dust discounts only matched value, not the whole counterparty', () => {
    const inbound = receipt('provider');
    inbound.payload = { ...inbound.payload, rawAmount: '100000000000000000000', amountDecimal: '100', amount: 100 };
    const outbound = receipt('consumer', 2);
    outbound.payload = { ...outbound.payload, rawAmount: '1', amountDecimal: '0.000000000000000001', amount: 1e-18 };
    const result = score([inbound, outbound]);
    expect(result.provider.hasSignal).toBe(true);
    expect(result.provider.score).toBe(5.06);
    expect(result.consumer.hasSignal).toBe(false);
    expect(result.evidence.matchedReciprocalRawAmount).toBe('1');
  });
  test('amount cannot buy score and exact submicro values still provide evidence', () => {
    const tiny = receipt('provider');
    tiny.payload = { ...tiny.payload, rawAmount: '1', amountDecimal: '0.000000000000000001', amount: 1e-18 };
    expect(score([tiny]).provider.score).toBe(score([receipt('provider')]).provider.score);
  });
  test('continuity is observed span, never passive wallet aging; recency is bounded', () => {
    const old = receipt('provider', 1, { observed_at: '2026-01-01T00:00:00Z' });
    expect(score([old]).provider.metrics!.continuity).toBe(0);
    expect(score([old]).provider.score).toBe(4.05);
    expect(score([old, receipt('provider', 2)]).provider.metrics!.continuity).toBe(1);
  });
  test('thick behavior uses existing evidence gates and can never be Excellent', () => {
    const rows = Array.from({ length: 500 }, (_, i) => receipt('provider', i + 1, {
      observed_at: new Date(now.getTime() - i * 86400000).toISOString(),
    }));
    rows.forEach((row, i) => { row.payload = { ...row.payload, counterparty: `0x${(i % 10 + 10).toString(16).padStart(40, '0')}` }; });
    expect(score(rows).provider).toMatchObject({ score: 100, trustTier: 'Very Good', confidenceBadge: 'behavior-inferred' });
  });
});
