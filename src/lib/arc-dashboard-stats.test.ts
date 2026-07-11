/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import {
  aggregateArcQuality,
  aggregateArcTransactions,
  countAgentsWithReceipts,
  emptyArcDashboardStats,
  filterAgentPayments,
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

describe('filterAgentPayments', () => {
  const REG = '0xRegisteredPayee';
  const NOISE = '0xNoisePayee';
  const registered = new Set([REG.toLowerCase()]);

  function row(counterparty: string, ts: string, sig = ts) {
    return {
      tx_signature: sig,
      wallet_address: '0xPayer',
      counterparty,
      amount: 0.002,
      timestamp: ts,
    };
  }

  test('keeps rows whose payee is a registered agent, drops noise', () => {
    const out = filterAgentPayments(
      [row(REG, '2026-07-12T00:03:00Z'), row(NOISE, '2026-07-12T00:02:00Z'), row(REG, '2026-07-12T00:01:00Z')],
      registered,
    );
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.counterparty === REG)).toBe(true);
    // preserves input order (caller pre-sorts desc)
    expect(out[0].timestamp).toBe('2026-07-12T00:03:00Z');
  });

  test('matches payee case-insensitively', () => {
    const out = filterAgentPayments([row(REG.toUpperCase(), '2026-07-12T00:01:00Z')], registered);
    expect(out).toHaveLength(1);
  });

  test('respects the limit', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(REG, `2026-07-12T00:${String(i).padStart(2, '0')}:00Z`, `sig${i}`));
    expect(filterAgentPayments(rows, registered, 8)).toHaveLength(8);
  });

  test('empty registered set → nothing', () => {
    expect(filterAgentPayments([row(REG, '2026-07-12T00:01:00Z')], new Set())).toHaveLength(0);
  });

  test('null/blank payee is skipped', () => {
    const out = filterAgentPayments(
      [{ tx_signature: 's', wallet_address: '0xP', counterparty: null, amount: 1, timestamp: 't' }],
      registered,
    );
    expect(out).toHaveLength(0);
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
