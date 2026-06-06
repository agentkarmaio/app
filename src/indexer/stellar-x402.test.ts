/// <reference types="bun-types" />
/**
 * U2 — Stellar x402/MPP receipt indexer tests.
 *
 * Mock strategy: DEPENDENCY INJECTION (mirrors wallet-scan.test.ts). The
 * indexer core accepts an injected `getEvents` + DB hooks so tests drive the
 * Soroban RPC response deterministically without a live RPC endpoint.
 *
 * Run: bun test src/indexer/stellar-x402.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { Address, Keypair, nativeToScVal, StrKey } from '@stellar/stellar-sdk';
import {
  parseTransferEvent,
  classifyProtocol,
  attributeTransfer,
  toTransactionRow,
  stellarReceiptIndexer,
  type RawSorobanEvent,
  type StellarTransferEvent,
} from './stellar-x402';
import { USDC_SAC } from '../config/stellar-x402';
import type { Transaction } from '../db/schema';

// ── Fixture addresses — real StrKey, generated inline (Correction C5). ────────
// Deterministic ed25519 accounts from fixed seeds keep the suite reproducible
// while passing `new Address()` validation (placeholder G…/C… literals fail it).
function seededAccount(byte: number): string {
  return Keypair.fromRawEd25519Seed(Buffer.alloc(32, byte)).publicKey();
}
const CONSUMER = seededAccount(1);
const PROVIDER = seededAccount(2);
const FACILITATOR = seededAccount(3);
const CHANNEL_C = StrKey.encodeContract(Buffer.alloc(32, 4)); // valid C… contract
const SAC = USDC_SAC.pubnet;

// ── Fixture factory: a raw SAC transfer event as the SDK rpc.getEvents yields ─
function makeTransferEvent(opts: {
  from: string;
  to: string;
  amount: bigint; // i128 base units (7 decimals)
  ledger?: number;
  txHash?: string;
  txSourceAccount?: string;
  txSuccessful?: boolean;
  contractId?: string;
}): RawSorobanEvent {
  const topic = [
    nativeToScVal('transfer', { type: 'symbol' }),
    new Address(opts.from).toScVal(),
    new Address(opts.to).toScVal(),
  ];
  const value = nativeToScVal(opts.amount, { type: 'i128' });
  return {
    id: '00000' + Math.random().toString(36).slice(2),
    type: 'contract',
    ledger: opts.ledger ?? 1000,
    ledgerClosedAt: '2026-06-06T00:00:00Z',
    contractId: opts.contractId ?? SAC,
    topic,
    value,
    txHash: opts.txHash ?? 'abc123def456',
    txSourceAccount: opts.txSourceAccount ?? FACILITATOR,
    txSuccessful: opts.txSuccessful ?? true,
  };
}

describe('parseTransferEvent', () => {
  test('decodes from/to/amount from ScVal topics + value', () => {
    const raw = makeTransferEvent({ from: CONSUMER, to: PROVIDER, amount: BigInt(10_000_000) }); // 1.0 USDC
    const ev = parseTransferEvent(raw);
    expect(ev).not.toBeNull();
    expect(ev!.from).toBe(CONSUMER);
    expect(ev!.to).toBe(PROVIDER);
    expect(ev!.rawAmount).toBe(BigInt(10_000_000));
    expect(ev!.amount).toBe(1.0); // rawAmount / 1e7
    expect(ev!.txHash).toBe('abc123def456');
    expect(ev!.txSourceAccount).toBe(FACILITATOR);
    expect(ev!.txSuccessful).toBe(true);
    expect(ev!.ledger).toBe(1000);
  });

  test('returns null when the first topic is not the "transfer" symbol', () => {
    const raw = makeTransferEvent({ from: CONSUMER, to: PROVIDER, amount: BigInt(1) });
    raw.topic[0] = nativeToScVal('mint', { type: 'symbol' });
    expect(parseTransferEvent(raw)).toBeNull();
  });

  test('applies 7-decimal scaling (sub-cent amount)', () => {
    const raw = makeTransferEvent({ from: CONSUMER, to: PROVIDER, amount: BigInt(10_000) }); // 0.001 USDC
    const ev = parseTransferEvent(raw);
    expect(ev!.amount).toBeCloseTo(0.001, 9);
  });
});

describe('classifyProtocol', () => {
  const base: StellarTransferEvent = {
    id: 'e', ledger: 1, ledgerClosedAt: 'x', txHash: 't',
    txSourceAccount: FACILITATOR, txSuccessful: true,
    from: CONSUMER, to: PROVIDER, rawAmount: BigInt(1), amount: 0, protocol: 'unknown',
  };

  test('x402 when tx source is a known facilitator', () => {
    expect(classifyProtocol({ ...base, txSourceAccount: FACILITATOR },
      { facilitators: new Set([FACILITATOR]), mppRecipients: new Set() })).toBe('x402');
  });

  test('mpp_channel_deposit when recipient is a contract (C...)', () => {
    expect(classifyProtocol({ ...base, txSourceAccount: CONSUMER, to: CHANNEL_C },
      { facilitators: new Set(), mppRecipients: new Set() })).toBe('mpp_channel_deposit');
  });

  test('mpp_channel_close when sender is a contract (C...)', () => {
    expect(classifyProtocol({ ...base, txSourceAccount: PROVIDER, from: CHANNEL_C },
      { facilitators: new Set(), mppRecipients: new Set() })).toBe('mpp_channel_close');
  });

  test('mpp_charge when recipient is a known MPP provider', () => {
    expect(classifyProtocol({ ...base, txSourceAccount: CONSUMER, to: PROVIDER },
      { facilitators: new Set(), mppRecipients: new Set([PROVIDER]) })).toBe('mpp_charge');
  });

  test('unknown when nothing matches', () => {
    expect(classifyProtocol({ ...base, txSourceAccount: CONSUMER },
      { facilitators: new Set(), mppRecipients: new Set() })).toBe('unknown');
  });

  test('facilitator wins over a contract recipient (x402 fee-bump precedence)', () => {
    expect(classifyProtocol({ ...base, txSourceAccount: FACILITATOR, to: CHANNEL_C },
      { facilitators: new Set([FACILITATOR]), mppRecipients: new Set() })).toBe('x402');
  });
});

describe('attributeTransfer + toTransactionRow', () => {
  test('x402 → consumer=from, provider=to', () => {
    const ev = parseTransferEvent(makeTransferEvent({
      from: CONSUMER, to: PROVIDER, amount: BigInt(5_000_000), txSourceAccount: FACILITATOR,
    }))!;
    ev.protocol = 'x402';
    const a = attributeTransfer(ev);
    expect(a.consumer).toBe(CONSUMER);
    expect(a.provider).toBe(PROVIDER);
  });

  test('mpp_channel_deposit → provider is the channel contract', () => {
    const ev = parseTransferEvent(makeTransferEvent({ from: CONSUMER, to: CHANNEL_C, amount: BigInt(1) }))!;
    ev.protocol = 'mpp_channel_deposit';
    const a = attributeTransfer(ev);
    expect(a.consumer).toBe(CONSUMER);
    expect(a.provider).toBe(CHANNEL_C);
  });

  test('toTransactionRow maps to the AK transactions schema (chain=stellar)', () => {
    const ev = parseTransferEvent(makeTransferEvent({
      from: CONSUMER, to: PROVIDER, amount: BigInt(1_234_567),
      txSourceAccount: FACILITATOR, txHash: 'deadbeef', txSuccessful: true,
    }))!;
    ev.protocol = 'x402';
    const row = toTransactionRow(ev);
    expect(row.chain).toBe('stellar');
    expect(row.wallet_address).toBe(CONSUMER);
    expect(row.facilitator).toBe(FACILITATOR);
    expect(row.amount).toBeCloseTo(0.1234567, 9);
    expect(row.timestamp).toBe('2026-06-06T00:00:00Z');
    expect(row.success).toBe(true);
    expect(row.tx_signature).toBe('deadbeef');
  });

  test('failed tx still rows with success=false', () => {
    const ev = parseTransferEvent(makeTransferEvent({
      from: CONSUMER, to: PROVIDER, amount: BigInt(1), txSuccessful: false,
    }))!;
    ev.protocol = 'x402';
    expect(toTransactionRow(ev).success).toBe(false);
  });
});

describe('stellarReceiptIndexer — DI core', () => {
  test('empty facilitator + recipient sets → no-op (0 fetched, getEvents not called)', async () => {
    let getEventsCalls = 0;
    const res = await stellarReceiptIndexer({
      sac: SAC,
      facilitators: new Set(),
      mppRecipients: new Set(),
      getEvents: async () => { getEventsCalls++; return { events: [], latestLedger: 2000 }; },
      insertTransactions: async () => 0,
      insertSignalEvents: async () => 0,
      ensureWallet: async () => {},
      getCursor: async () => null,
      upsertCursor: async () => {},
    });
    expect(res.fetched).toBe(0);
    expect(res.inserted).toBe(0);
    expect(getEventsCalls).toBe(0); // skipped: nothing to match
  });

  test('one facilitator-sourced x402 transfer → 1 insert + 2 signals + cursor=maxLedger', async () => {
    const inserted: Array<Omit<Transaction, 'id'>> = [];
    const signals: unknown[] = [];
    const cursors: Array<[string, string, number | undefined]> = [];
    const ensured: string[] = [];

    const ev = makeTransferEvent({
      from: CONSUMER, to: PROVIDER, amount: BigInt(2_000_000), // 0.2 USDC
      txSourceAccount: FACILITATOR, txHash: 'sig_x402', ledger: 1500,
    });

    const res = await stellarReceiptIndexer({
      sac: SAC,
      facilitators: new Set([FACILITATOR]),
      mppRecipients: new Set(),
      getEvents: async () => ({ events: [ev], latestLedger: 1500 }),
      insertTransactions: async (rows) => { inserted.push(...rows); return rows.length; },
      insertSignalEvents: async (s) => { signals.push(...s); return s.length; },
      ensureWallet: async (a) => { ensured.push(a); },
      getCursor: async () => null,
      upsertCursor: async (key, last, slot) => { cursors.push([key, last, slot]); },
    });

    expect(res.fetched).toBe(1);
    expect(inserted.length).toBe(1);
    expect(inserted[0].chain).toBe('stellar');
    expect(inserted[0].wallet_address).toBe(CONSUMER);
    expect(inserted[0].facilitator).toBe(FACILITATOR);
    expect(inserted[0].amount).toBeCloseTo(0.2, 9);
    expect(inserted[0].tx_signature).toBe('sig_x402');
    // consumer + provider Tier-1 paysh_routed signals (mirrors indexer/index.ts)
    expect(signals.length).toBe(2);
    // both faces' wallets ensured for the FK
    expect(ensured).toContain(CONSUMER);
    expect(ensured).toContain(PROVIDER);
    // cursor: key namespaced by SAC, value = String(maxLedger), slot = maxLedger
    expect(cursors.length).toBe(1);
    expect(cursors[0][0]).toBe(`stellar:${SAC}`);
    expect(cursors[0][1]).toBe('1500');
    expect(cursors[0][2]).toBe(1500);
    // shared IndexRunResult contract: cursors Map carries the same entry
    expect(res.cursors.get(`stellar:${SAC}`)).toBe('1500');
  });

  test('unknown transfers (no facilitator, no recipient match) are skipped', async () => {
    const inserted: Array<Omit<Transaction, 'id'>> = [];
    const ev = makeTransferEvent({
      from: CONSUMER, to: PROVIDER, amount: BigInt(1), txSourceAccount: CONSUMER, // self-sourced, not a facilitator
    });
    const res = await stellarReceiptIndexer({
      sac: SAC,
      facilitators: new Set([FACILITATOR]),
      mppRecipients: new Set(),
      getEvents: async () => ({ events: [ev], latestLedger: 900 }),
      insertTransactions: async (rows) => { inserted.push(...rows); return rows.length; },
      insertSignalEvents: async () => 0,
      ensureWallet: async () => {},
      getCursor: async () => null,
      upsertCursor: async () => {},
    });
    expect(res.fetched).toBe(0);
    expect(inserted.length).toBe(0);
  });

  test('startLedger = cursor.last_slot + 1 when a cursor exists', async () => {
    let seenStart: number | undefined;
    await stellarReceiptIndexer({
      sac: SAC,
      facilitators: new Set([FACILITATOR]),
      mppRecipients: new Set(),
      getEvents: async (start) => { seenStart = start; return { events: [], latestLedger: 5000 }; },
      insertTransactions: async () => 0,
      insertSignalEvents: async () => 0,
      ensureWallet: async () => {},
      getCursor: async () => ({ last_signature: '4200', last_slot: 4200 }),
      upsertCursor: async () => {},
    });
    expect(seenStart).toBe(4201);
  });

  test('mpp_charge transfer to a known recipient is indexed', async () => {
    const inserted: Array<Omit<Transaction, 'id'>> = [];
    const ev = makeTransferEvent({
      from: CONSUMER, to: PROVIDER, amount: BigInt(3_000_000), txSourceAccount: CONSUMER,
    });
    const res = await stellarReceiptIndexer({
      sac: SAC,
      facilitators: new Set(),
      mppRecipients: new Set([PROVIDER]),
      getEvents: async () => ({ events: [ev], latestLedger: 100 }),
      insertTransactions: async (rows) => { inserted.push(...rows); return rows.length; },
      insertSignalEvents: async () => 0,
      ensureWallet: async () => {},
      getCursor: async () => null,
      upsertCursor: async () => {},
    });
    expect(res.fetched).toBe(1);
    expect(inserted[0].facilitator).toBe(CONSUMER); // mpp source = payer-submitted tx source
  });
});

describe('stellarReceiptIndexer — runtime integration', () => {
  test.skip('end-to-end against live Soroban RPC + Supabase', async () => {
    // integration: requires STELLAR_RPC_URL + seeded STELLAR_FACILITATORS + DB.
    // const res = await runStellarIndexer();
  });
});
