/// <reference types="bun-types" />
/**
 * Settlement Quality — receipt-gated, Sybil-discounted delivery signal.
 *
 * Scoring-critical → exhaustive. This is the metric that separates a genuinely
 * productive agent from one with FARMED reputation: on a permissionless
 * ERC-8004/8183 chain, feedback and even settlements can be self-issued, so the
 * only durable proof is receipt-gated settlements across DISTINCT, non-Sybil
 * counterparties. A count-and-label (not a fake percentage), mirroring surety's
 * min-sample gate + index.ts's Sybil funnel heuristic.
 */

import { describe, expect, test } from 'bun:test';
import {
  computeSettlementQuality,
  settlementReceiptsFromSignals,
  SETTLEMENT_MIN_FOR_PROVEN,
  SETTLEMENT_SYBIL_FUNNEL_AVG,
  type SettlementReceipt,
} from './settlement-quality';

/** Build n receipts spread round-robin across `counterparties` distinct payers. */
function mkReceipts(opts: { n: number; counterparties: number; amount?: number }): SettlementReceipt[] {
  const { n, counterparties, amount } = opts;
  return Array.from({ length: n }, (_, i) => ({
    counterparty: `0xCP${(i % counterparties).toString().padStart(38, '0')}`,
    amount,
  }));
}

describe('computeSettlementQuality — presence gate', () => {
  test('no receipts → null (no axis to show)', () => {
    expect(computeSettlementQuality([])).toBeNull();
  });

  test('fewer than the min-sample gate → unproven ⚪', () => {
    const r = computeSettlementQuality(mkReceipts({ n: SETTLEMENT_MIN_FOR_PROVEN - 1, counterparties: 2 }));
    expect(r).not.toBeNull();
    expect(r!.label).toBe('unproven');
    expect(r!.badge).toBe('⚪');
    expect(r!.settledCount).toBe(SETTLEMENT_MIN_FOR_PROVEN - 1);
  });
});

describe('computeSettlementQuality — reliable / mixed', () => {
  test('≥3 receipts across ≥3 distinct counterparties → reliable 🟢', () => {
    const r = computeSettlementQuality(mkReceipts({ n: 3, counterparties: 3 }))!;
    expect(r.label).toBe('reliable');
    expect(r.badge).toBe('🟢');
    expect(r.distinctCounterparties).toBe(3);
    expect(r.sybilFunnel).toBe(false);
  });

  test('enough receipts but thin counterparty breadth (1–2 distinct) → mixed 🟡', () => {
    const r = computeSettlementQuality(mkReceipts({ n: 6, counterparties: 2 }))!;
    expect(r.label).toBe('mixed');
    expect(r.badge).toBe('🟡');
    expect(r.distinctCounterparties).toBe(2);
  });

  test('healthy high-volume spread stays reliable (not funnel)', () => {
    const r = computeSettlementQuality(mkReceipts({ n: 25, counterparties: 10 }))!;
    expect(r.label).toBe('reliable');
    expect(r.sybilFunnel).toBe(false);
  });
});

describe('computeSettlementQuality — Sybil funnel (wash-trade guard)', () => {
  test('high volume through <3 counterparties (avg ≥ funnel threshold) → unproven, flagged', () => {
    // 40 receipts / 2 counterparties = avg 20 ≥ SETTLEMENT_SYBIL_FUNNEL_AVG, distinct < 3
    const r = computeSettlementQuality(mkReceipts({ n: SETTLEMENT_SYBIL_FUNNEL_AVG * 2, counterparties: 2 }))!;
    expect(r.sybilFunnel).toBe(true);
    expect(r.label).toBe('unproven');
  });

  test('spreading the same volume across ≥3 counterparties escapes the funnel', () => {
    const r = computeSettlementQuality(mkReceipts({ n: SETTLEMENT_SYBIL_FUNNEL_AVG * 3, counterparties: 3 }))!;
    expect(r.sybilFunnel).toBe(false);
    expect(r.label).toBe('reliable');
  });
});

describe('computeSettlementQuality — counterparty normalization', () => {
  test('same address in different case / whitespace counts once', () => {
    const receipts: SettlementReceipt[] = [
      { counterparty: '0xAbC' }, { counterparty: '0xabc ' }, { counterparty: ' 0xABC' },
    ];
    const r = computeSettlementQuality(receipts)!;
    expect(r.distinctCounterparties).toBe(1);
    expect(r.label).toBe('mixed'); // 3 receipts, 1 distinct
  });

  test('empty / zero-address counterparties are not counted as distinct', () => {
    const receipts: SettlementReceipt[] = [
      { counterparty: '' },
      { counterparty: '0x0000000000000000000000000000000000000000' },
      { counterparty: '0xReal' },
    ];
    const r = computeSettlementQuality(receipts)!;
    expect(r.distinctCounterparties).toBe(1);
  });

  test('receipts with only unidentifiable counterparties → unproven', () => {
    const receipts: SettlementReceipt[] = [
      { counterparty: '' }, { counterparty: '' }, { counterparty: '' }, { counterparty: '' },
    ];
    const r = computeSettlementQuality(receipts)!;
    expect(r.distinctCounterparties).toBe(0);
    expect(r.label).toBe('unproven');
  });
});

describe('settlementReceiptsFromSignals — adapter', () => {
  const events = [
    { kind: 'erc8183_job_settled', face: 'provider', signed_by: '0xClientA', payload: { amount: 5 } },
    { kind: 'erc8183_job_settled', face: 'provider', signed_by: '0xClientB', payload: { amount: 3 } },
    { kind: 'erc8183_job_settled', face: 'consumer', signed_by: '0xProviderX', payload: { amount: 9 } },
    { kind: 'metadata_quality', face: 'provider', signed_by: null, payload: null },
  ];

  test('extracts only settlement receipts for the requested face', () => {
    const prov = settlementReceiptsFromSignals(events, 'provider');
    expect(prov).toHaveLength(2);
    expect(prov.map((r) => r.counterparty)).toEqual(['0xClientA', '0xClientB']);
    expect(prov[0].amount).toBe(5);

    const cons = settlementReceiptsFromSignals(events, 'consumer');
    expect(cons).toHaveLength(1);
    expect(cons[0].counterparty).toBe('0xProviderX');
  });

  test('falls back to payload.counterparty when signed_by is absent', () => {
    const r = settlementReceiptsFromSignals(
      [{ kind: 'erc8183_job_settled', face: 'provider', signed_by: null, payload: { counterparty: '0xFromPayload' } }],
      'provider',
    );
    expect(r[0].counterparty).toBe('0xFromPayload');
  });

  test('end-to-end: farmed agent (many self-settlements, one counterparty) reads unproven', () => {
    const farmed = Array.from({ length: 50 }, () => ({
      kind: 'erc8183_job_settled', face: 'provider', signed_by: '0xSelfCluster', payload: { amount: 1 },
    }));
    const quality = computeSettlementQuality(settlementReceiptsFromSignals(farmed, 'provider'))!;
    expect(quality.label).toBe('unproven');
    expect(quality.sybilFunnel).toBe(true);
  });
});
