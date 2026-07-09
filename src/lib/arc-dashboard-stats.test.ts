/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import {
  aggregateArcQuality,
  aggregateArcTransactions,
  countAgentsWithReceipts,
  emptyArcDashboardStats,
  mapRecentSettlements,
  parseArcTxHash,
} from './arc-dashboard-stats';
import { ERC8183_SETTLED_KIND } from '@/scoring/settlement-quality';

describe('aggregateArcTransactions', () => {
  test('sums volume and counts distinct agents on both sides', () => {
    const r = aggregateArcTransactions([
      { amount: '10.5', wallet_address: '0xClientA', counterparty: '0xProv1' },
      { amount: 2, wallet_address: '0xClientB', counterparty: '0xProv1' },
      { amount: 1, wallet_address: '0xClientA', counterparty: '0xProv2' },
    ]);
    expect(r.matchedSettlements).toBe(3);
    expect(r.volumeUsdc).toBeCloseTo(13.5);
    // clientA, clientB, prov1, prov2
    expect(r.distinctAgents).toBe(4);
  });

  test('empty input → zeros', () => {
    expect(aggregateArcTransactions([])).toEqual({
      matchedSettlements: 0,
      volumeUsdc: 0,
      distinctAgents: 0,
    });
  });
});

describe('aggregateArcQuality', () => {
  function providerEvents(
    wallet: string,
    counterparties: string[],
  ) {
    return counterparties.map((cp, i) => ({
      agent_wallet: wallet,
      kind: ERC8183_SETTLED_KIND,
      face: 'provider' as const,
      signed_by: cp,
      payload: { counterparty: cp, amount: 1 },
      // unique-ish for readability
      _i: i,
    }));
  }

  test('≥3 receipts across ≥3 counterparties → reliable', () => {
    const q = aggregateArcQuality(
      providerEvents('0xAgent', ['0xa', '0xb', '0xc']),
    );
    expect(q).toEqual({ reliable: 1, mixed: 0, unproven: 0 });
  });

  test('enough receipts but thin counterparties → mixed', () => {
    // 3 receipts, 2 counterparties → mixed (not reliable, not unproven)
    const q = aggregateArcQuality(
      providerEvents('0xAgent', ['0xa', '0xb', '0xa']),
    );
    expect(q).toEqual({ reliable: 0, mixed: 1, unproven: 0 });
  });

  test('wash funnel (high volume, <3 cp) → unproven', () => {
    const cps = Array.from({ length: 20 }, () => '0xonly');
    const q = aggregateArcQuality(providerEvents('0xFarm', cps));
    expect(q).toEqual({ reliable: 0, mixed: 0, unproven: 1 });
  });

  test('ignores consumer face and non-settlement kinds', () => {
    const q = aggregateArcQuality([
      {
        agent_wallet: '0xAgent',
        kind: ERC8183_SETTLED_KIND,
        face: 'consumer',
        signed_by: '0xOther',
      },
      {
        agent_wallet: '0xAgent',
        kind: 'paysh_routed',
        face: 'provider',
        signed_by: '0xOther',
      },
    ]);
    expect(q).toEqual({ reliable: 0, mixed: 0, unproven: 0 });
  });

  test('histogram across multiple agents', () => {
    const events = [
      ...providerEvents('0xGood', ['0xa', '0xb', '0xc']),
      ...providerEvents('0xThin', ['0xa', '0xb', '0xa']),
      ...providerEvents('0xNew', ['0xa']), // < min sample → unproven
    ];
    expect(aggregateArcQuality(events)).toEqual({
      reliable: 1,
      mixed: 1,
      unproven: 1,
    });
  });
});

describe('countAgentsWithReceipts', () => {
  test('counts distinct providers only', () => {
    const n = countAgentsWithReceipts([
      { agent_wallet: '0xA', kind: ERC8183_SETTLED_KIND, face: 'provider' },
      { agent_wallet: '0xA', kind: ERC8183_SETTLED_KIND, face: 'provider' },
      { agent_wallet: '0xB', kind: ERC8183_SETTLED_KIND, face: 'provider' },
      { agent_wallet: '0xC', kind: ERC8183_SETTLED_KIND, face: 'consumer' },
    ]);
    expect(n).toBe(2);
  });
});

describe('parseArcTxHash / mapRecentSettlements', () => {
  test('strips jobId: prefix for explorer hash', () => {
    expect(parseArcTxHash('42:0xabc')).toBe('0xabc');
    expect(parseArcTxHash('0xabc')).toBe('0xabc');
  });

  test('maps recent rows', () => {
    const recent = mapRecentSettlements([
      {
        tx_signature: '7:0xdead',
        wallet_address: '0xClient',
        counterparty: '0xProv',
        amount: '1.25',
        timestamp: '2026-07-01T00:00:00Z',
      },
    ]);
    expect(recent[0]).toEqual({
      txSignature: '7:0xdead',
      txHash: '0xdead',
      walletAddress: '0xClient',
      counterparty: '0xProv',
      amount: 1.25,
      timestamp: '2026-07-01T00:00:00Z',
    });
  });
});

describe('emptyArcDashboardStats', () => {
  test('flags empty and preserves registry secondary', () => {
    const s = emptyArcDashboardStats({ agents: 100, feedbacks: 50 });
    expect(s.empty).toBe(true);
    expect(s.matchedSettlements).toBe(0);
    expect(s.registry).toEqual({ agents: 100, feedbacks: 50 });
  });
});
