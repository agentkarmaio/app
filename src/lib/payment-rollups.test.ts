import { describe, expect, test } from 'bun:test';
import { ALL_FACILITATOR_ADDRESSES, SOLANA_FACILITATORS, USDC_MINT } from '@/config/facilitators';
import { ARC_ESCROW_FACILITATOR, ARC_USDC_CONTRACT } from '@/config/arc-facilitators';
import {
  buildPaymentRollups,
  facilitatorLabel,
  foldCounterparties,
  foldFacilitators,
  foldPayers,
  isKnownFacilitatorAddress,
  type InboundRow,
  type OutboundRow,
} from '@/lib/payment-rollups';

const FACILITATOR = ALL_FACILITATOR_ADDRESSES[0];

function out(over: Partial<OutboundRow> = {}): OutboundRow {
  return {
    counterparty: 'PAYEE_A',
    facilitator: FACILITATOR,
    amount: 1,
    timestamp: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

function inb(over: Partial<InboundRow> = {}): InboundRow {
  return {
    wallet_address: 'PAYER_A',
    amount: 1,
    timestamp: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

describe('foldCounterparties', () => {
  test('groups by payee, summing credited value and counting receipts', () => {
    const r = foldCounterparties(
      [
        out({ counterparty: 'PAYEE_A', amount: 2 }),
        out({ counterparty: 'PAYEE_A', amount: 3 }),
        out({ counterparty: 'PAYEE_B', amount: 1 }),
      ],
      'solana',
    );
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0]).toMatchObject({ address: 'PAYEE_A', count: 2, total: 5 });
    expect(r.entries[1]).toMatchObject({ address: 'PAYEE_B', count: 1, total: 1 });
    expect(r.receipts).toBe(3);
    expect(r.total).toBe(6);
  });

  test('orders by credited value, not insertion order', () => {
    const r = foldCounterparties(
      [out({ counterparty: 'SMALL', amount: 1 }), out({ counterparty: 'BIG', amount: 9 })],
      'solana',
    );
    expect(r.entries.map((e) => e.address)).toEqual(['BIG', 'SMALL']);
  });

  test('lastSeen is the most recent receipt in the relationship', () => {
    const r = foldCounterparties(
      [
        out({ counterparty: 'P', timestamp: '2026-09-01T00:00:00.000Z' }),
        out({ counterparty: 'P', timestamp: '2026-09-09T00:00:00.000Z' }),
        out({ counterparty: 'P', timestamp: '2026-09-05T00:00:00.000Z' }),
      ],
      'solana',
    );
    expect(r.entries[0].lastSeen).toBe('2026-09-09T00:00:00.000Z');
  });

  test('a null payee is counted as unattributed, never dropped', () => {
    const r = foldCounterparties(
      [out({ counterparty: null }), out({ counterparty: null }), out({ counterparty: 'P' })],
      'solana',
    );
    expect(r.unattributed).toBe(2);
    expect(r.receipts).toBe(3);
    expect(r.entries).toHaveLength(1);
    // Value from unattributed rows still counts toward the direction total —
    // the payment happened, we just can't say to whom.
    expect(r.total).toBe(3);
  });

  test('a tracked facilitator credited as payee is held out of the partner list', () => {
    const r = foldCounterparties(
      [out({ counterparty: FACILITATOR }), out({ counterparty: 'REAL_PAYEE' })],
      'solana',
    );
    expect(r.entries.map((e) => e.address)).toEqual(['REAL_PAYEE']);
    expect(r.facilitatorCredited).toBe(1);
    expect(r.unattributed).toBe(0);
  });

  test('the facilitator exclusion is Solana-only', () => {
    const r = foldCounterparties(
      [{ counterparty: FACILITATOR, facilitator: 'f', amount: 1, timestamp: '2026-09-01T00:00:00.000Z' }],
      'celo',
    );
    expect(r.entries.map((e) => e.address)).toEqual([FACILITATOR]);
    expect(r.facilitatorCredited).toBe(0);
  });

  test('non-finite and negative amounts contribute no value but still count', () => {
    const r = foldCounterparties(
      [
        out({ counterparty: 'P', amount: Number.NaN }),
        out({ counterparty: 'P', amount: -5 }),
        out({ counterparty: 'P', amount: 2 }),
      ],
      'solana',
    );
    expect(r.entries[0]).toMatchObject({ count: 3, total: 2 });
    expect(r.total).toBe(2);
  });

  test('EVM addresses fold case-insensitively; Solana base58 does not', () => {
    const evm = foldCounterparties(
      [
        { counterparty: '0xABC', facilitator: 'f', amount: 1, timestamp: '2026-09-01T00:00:00.000Z' },
        { counterparty: '0xabc', facilitator: 'f', amount: 1, timestamp: '2026-09-02T00:00:00.000Z' },
      ],
      'celo',
    );
    expect(evm.entries).toHaveLength(1);
    expect(evm.entries[0].count).toBe(2);

    const sol = foldCounterparties(
      [out({ counterparty: 'Abc' }), out({ counterparty: 'abc' })],
      'solana',
    );
    expect(sol.entries).toHaveLength(2);
  });
});

describe('foldPayers', () => {
  test('groups inbound value by the paying wallet', () => {
    const r = foldPayers(
      [inb({ wallet_address: 'X', amount: 4 }), inb({ wallet_address: 'X', amount: 1 }), inb({ wallet_address: 'Y', amount: 2 })],
      'solana',
    );
    expect(r.entries[0]).toMatchObject({ address: 'X', count: 2, total: 5 });
    expect(r.unattributed).toBe(0);
  });

  test('a facilitator that pays this wallet is a real payer and is kept', () => {
    const r = foldPayers([inb({ wallet_address: FACILITATOR })], 'solana');
    expect(r.entries.map((e) => e.address)).toEqual([FACILITATOR]);
    expect(r.facilitatorCredited).toBe(0);
  });
});

describe('foldFacilitators', () => {
  test('every outbound receipt lands in exactly one facilitator bucket', () => {
    const rows = [out({ facilitator: 'F1' }), out({ facilitator: 'F1' }), out({ facilitator: 'F2' })];
    const entries = foldFacilitators(rows, 'solana');
    expect(entries.reduce((n, e) => n + e.count, 0)).toBe(rows.length);
    expect(entries[0]).toMatchObject({ address: 'F1', count: 2, label: null });
  });

  test('one operator running several addresses folds into ONE bucket', () => {
    const [a, b] = SOLANA_FACILITATORS.coinbase;
    const entries = foldFacilitators(
      [out({ facilitator: a, amount: 1 }), out({ facilitator: b, amount: 2 })],
      'solana',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ label: 'coinbase', count: 2, total: 3 });
  });

  test('an unknown facilitator address keeps its own bucket and no label', () => {
    const entries = foldFacilitators([out({ facilitator: 'UNKNOWN_ADDR' })], 'solana');
    expect(entries[0]).toMatchObject({ address: 'UNKNOWN_ADDR', label: null });
  });
});

describe('isKnownFacilitatorAddress', () => {
  test('true for a tracked Solana facilitator, false off Solana, false otherwise', () => {
    expect(isKnownFacilitatorAddress(FACILITATOR, 'solana')).toBe(true);
    expect(isKnownFacilitatorAddress(FACILITATOR, 'arc')).toBe(false);
    expect(isKnownFacilitatorAddress('NOT_A_FACILITATOR', 'solana')).toBe(false);
  });
});

describe('buildPaymentRollups', () => {
  test('assembles both directions plus the facilitator strip and carries saturation', () => {
    const r = buildPaymentRollups({
      outbound: [out({ counterparty: 'PAYEE', facilitator: 'F1', amount: 3 })],
      inbound: [inb({ wallet_address: 'PAYER', amount: 7 })],
      chain: 'solana',
      saturated: true,
    });
    expect(r.paidTo.entries[0].address).toBe('PAYEE');
    expect(r.earnedFrom.entries[0].address).toBe('PAYER');
    expect(r.routedVia[0].address).toBe('F1');
    expect(r.saturated).toBe(true);
  });

  test('an empty window yields empty rollups, not a throw', () => {
    const r = buildPaymentRollups({ outbound: [], inbound: [], chain: 'solana', saturated: false });
    expect(r.paidTo.entries).toEqual([]);
    expect(r.earnedFrom.entries).toEqual([]);
    expect(r.routedVia).toEqual([]);
    expect(r.paidTo.total).toBe(0);
  });
});

describe('facilitatorLabel', () => {
  test('the USDC mint sentinel reads as a direct transfer, not a router', () => {
    expect(facilitatorLabel(USDC_MINT, 'solana')).toBe('direct transfer');
  });

  test('a tracked facilitator address resolves to its operator name', () => {
    expect(facilitatorLabel(SOLANA_FACILITATORS.coinbase[0], 'solana')).toBe('coinbase');
  });

  test('an unknown address gets no label', () => {
    expect(facilitatorLabel('SOME_OTHER_ADDRESS', 'solana')).toBeNull();
  });

  test('Arc names its own sentinel and its own escrow, case-insensitively', () => {
    expect(facilitatorLabel(ARC_USDC_CONTRACT, 'arc')).toBe('direct transfer');
    expect(facilitatorLabel(ARC_USDC_CONTRACT.toUpperCase().replace('0X', '0x'), 'arc')).toBe('direct transfer');
    expect(facilitatorLabel(ARC_ESCROW_FACILITATOR, 'arc')).toBe('Arc job escrow');
    expect(facilitatorLabel(ARC_ESCROW_FACILITATOR.toLowerCase(), 'arc')).toBe('Arc job escrow');
  });

  test('labels do not leak across chains', () => {
    // A Solana facilitator name must never be applied to an EVM address, and
    // Arc's escrow is only the escrow on Arc.
    expect(facilitatorLabel(USDC_MINT, 'arc')).toBeNull();
    expect(facilitatorLabel(ARC_ESCROW_FACILITATOR, 'solana')).toBeNull();
    expect(facilitatorLabel(ARC_ESCROW_FACILITATOR, 'celo')).toBeNull();
  });

  test('plain-transfer receipts fold into one "direct transfer" bucket', () => {
    const entries = foldFacilitators(
      [out({ facilitator: USDC_MINT }), out({ facilitator: USDC_MINT })],
      'solana',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ label: 'direct transfer', count: 2 });
  });
});
