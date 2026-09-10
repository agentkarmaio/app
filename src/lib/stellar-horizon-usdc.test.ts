/// <reference types="bun-types" />
/**
 * The single Horizon → USDC-movement decoder, tested directly.
 *
 * Three call sites depend on this: the SAC transfer indexer (Tier-1 receipts),
 * the x402 Horizon backfill, and the read-time independence signal. They fail
 * in different ways but for the same two reasons — a shape that is not decoded
 * (every Soroban settlement vanishes) or an asset that is not pinned (a
 * stranger's token scores as Circle's). Both are covered here once.
 *
 * Run: bun test src/lib/stellar-horizon-usdc.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { extractUsdcTransfers, type AssetPin } from './stellar-horizon-usdc';
import { USDC_ISSUER } from '@/config/stellar-x402';

const A = 'GC2NIKT6TWLMBZE4TU5ZMMDVV22URFIMJIZ4JYUC3QABBBWNGGZMAFGM';
const B = 'GDDTQFQZK734EXIJE5LWU4G4YC5A6P5AHJ4UWVMV6WBFWT6BAAQQHV2V';
const C = 'GBF4LIK2YZQPD72REKLTTAPR67XCMV5VA4JVST2ZB3JFXIHXJFDJ6B6F';
const FAKE_ISSUER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD';

const PIN: AssetPin = { code: 'USDC', issuer: USDC_ISSUER.pubnet };

const base = {
  id: '1',
  paging_token: '1',
  transaction_successful: true,
  source_account: A,
  created_at: '2026-09-01T00:00:00Z',
  transaction_hash: 'tx1',
};

describe('extractUsdcTransfers — the three USDC-carrying shapes', () => {
  test('classic payment', () => {
    const out = extractUsdcTransfers(
      { ...base, type: 'payment', from: A, to: B, amount: '1.5', asset_code: 'USDC', asset_issuer: USDC_ISSUER.pubnet },
      PIN,
    );
    expect(out).toEqual([
      { from: A, to: B, amount: 1.5, txHash: 'tx1', pagingToken: '1', createdAt: base.created_at, successful: true },
    ]);
  });

  test('Soroban invoke_host_function — the record itself has no from/to', () => {
    const out = extractUsdcTransfers(
      {
        ...base,
        type: 'invoke_host_function',
        asset_balance_changes: [
          { type: 'transfer', from: A, to: B, amount: '0.01', asset_code: 'USDC', asset_issuer: USDC_ISSUER.pubnet },
        ],
      },
      PIN,
    );
    expect(out.map((t) => [t.from, t.to, t.amount])).toEqual([[A, B, 0.01]]);
  });

  test('path_payment_strict_send matches on the DESTINATION asset', () => {
    const out = extractUsdcTransfers(
      {
        ...base, type: 'path_payment_strict_send', from: A, to: B, amount: '7',
        asset_code: 'USDC', asset_issuer: USDC_ISSUER.pubnet,
        source_asset_code: 'XLM', source_asset_issuer: undefined,
      },
      PIN,
    );
    expect(out.map((t) => t.amount)).toEqual([7]);
  });

  test('path_payment_strict_receive too', () => {
    const out = extractUsdcTransfers(
      { ...base, type: 'path_payment_strict_receive', from: A, to: B, amount: '2', asset_code: 'USDC', asset_issuer: USDC_ISSUER.pubnet },
      PIN,
    );
    expect(out).toHaveLength(1);
  });

  test('a record can carry several legs', () => {
    const out = extractUsdcTransfers(
      {
        ...base,
        type: 'invoke_host_function',
        asset_balance_changes: [
          { type: 'transfer', from: A, to: B, amount: '1', asset_code: 'USDC', asset_issuer: USDC_ISSUER.pubnet },
          { type: 'transfer', from: B, to: C, amount: '2', asset_code: 'USDC', asset_issuer: USDC_ISSUER.pubnet },
        ],
      },
      PIN,
    );
    expect(out.map((t) => t.amount)).toEqual([1, 2]);
  });
});

describe('extractUsdcTransfers — asset identity is pinned, never a bare code', () => {
  test('same code "USDC", different issuer → nothing', () => {
    const out = extractUsdcTransfers(
      { ...base, type: 'payment', from: A, to: B, amount: '100', asset_code: 'USDC', asset_issuer: FAKE_ISSUER },
      PIN,
    );
    expect(out).toEqual([]);
  });

  test('the testnet issuer does not match a pubnet pin', () => {
    const out = extractUsdcTransfers(
      {
        ...base, type: 'invoke_host_function',
        asset_balance_changes: [
          { type: 'transfer', from: A, to: B, amount: '5', asset_code: 'USDC', asset_issuer: USDC_ISSUER.testnet },
        ],
      },
      PIN,
    );
    expect(out).toEqual([]);
  });

  test('another asset from the right issuer does not match either', () => {
    const out = extractUsdcTransfers(
      { ...base, type: 'payment', from: A, to: B, amount: '5', asset_code: 'EURC', asset_issuer: USDC_ISSUER.pubnet },
      PIN,
    );
    expect(out).toEqual([]);
  });
});

describe('extractUsdcTransfers — what is deliberately not a transfer', () => {
  test('a mint/burn balance change is asset infrastructure, not a payment', () => {
    const out = extractUsdcTransfers(
      {
        ...base, type: 'invoke_host_function',
        asset_balance_changes: [
          { type: 'mint', to: A, amount: '1000', asset_code: 'USDC', asset_issuer: USDC_ISSUER.pubnet },
          { type: 'burn', from: A, amount: '1000', asset_code: 'USDC', asset_issuer: USDC_ISSUER.pubnet },
        ],
      },
      PIN,
    );
    expect(out).toEqual([]);
  });

  test('an operation type that carries no value is ignored', () => {
    expect(extractUsdcTransfers({ ...base, type: 'create_account' }, PIN)).toEqual([]);
  });

  test('a zero or negative amount does not produce a movement', () => {
    const zero = extractUsdcTransfers(
      { ...base, type: 'payment', from: A, to: B, amount: '0', asset_code: 'USDC', asset_issuer: USDC_ISSUER.pubnet },
      PIN,
    );
    expect(zero).toEqual([]);
  });
});

describe('extractUsdcTransfers — malformed input is skipped, never thrown on', () => {
  // This contract is inherited from foldHorizonPayments, which is fed raw
  // Horizon JSON: one bad record must not take down a whole read.
  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'nope'],
    ['an empty object', {}],
    ['a bare type', { type: 'payment' }],
    ['a non-array asset_balance_changes', { type: 'invoke_host_function', asset_balance_changes: 'nope' }],
    ['a non-object balance change', { type: 'invoke_host_function', asset_balance_changes: [null, 7] }],
  ])('%s yields []', (_label, record) => {
    expect(extractUsdcTransfers(record, PIN)).toEqual([]);
  });

  test('a non-numeric amount is dropped without poisoning its siblings', () => {
    const out = extractUsdcTransfers(
      {
        ...base, type: 'invoke_host_function',
        asset_balance_changes: [
          { type: 'transfer', from: A, to: B, amount: 'not-a-number', asset_code: 'USDC', asset_issuer: USDC_ISSUER.pubnet },
          { type: 'transfer', from: A, to: C, amount: '3', asset_code: 'USDC', asset_issuer: USDC_ISSUER.pubnet },
        ],
      },
      PIN,
    );
    expect(out.map((t) => [t.to, t.amount])).toEqual([[C, 3]]);
  });

  test('a missing transaction_successful reads as successful, never undefined', () => {
    const [t] = extractUsdcTransfers(
      { type: 'payment', from: A, to: B, amount: '1', asset_code: 'USDC', asset_issuer: USDC_ISSUER.pubnet },
      PIN,
    );
    expect(t.successful).toBe(true);
  });

  test('an explicitly failed transaction stays failed', () => {
    const [t] = extractUsdcTransfers(
      { ...base, transaction_successful: false, type: 'payment', from: A, to: B, amount: '1', asset_code: 'USDC', asset_issuer: USDC_ISSUER.pubnet },
      PIN,
    );
    expect(t.successful).toBe(false);
  });
});

describe('extractUsdcTransfers — a movement needs two parties', () => {
  // REAL mainnet shape (GC2NIKT6…, captured 2026-09-10): a strict-send path
  // payment from an account to ITSELF is a DEX swap — 6 XLM in, 1.03 USDC out.
  // Nobody paid anybody. Counted as a movement it manufactures revenue from a
  // payer that is the account itself, which is what flipped a live independence
  // verdict from insufficient-data to independent during review.
  test('a DEX self-swap (path payment to itself) is not a transfer', () => {
    const out = extractUsdcTransfers(
      {
        ...base, type: 'path_payment_strict_send', from: A, to: A, amount: '1.0322630',
        asset_code: 'USDC', asset_issuer: USDC_ISSUER.pubnet, source_asset_code: 'XLM',
      },
      PIN,
    );
    expect(out).toEqual([]);
  });

  test('a classic payment to itself is not a transfer', () => {
    const out = extractUsdcTransfers(
      { ...base, type: 'payment', from: A, to: A, amount: '5', asset_code: 'USDC', asset_issuer: USDC_ISSUER.pubnet },
      PIN,
    );
    expect(out).toEqual([]);
  });

  test('a Soroban self-leg is dropped without dropping its real siblings', () => {
    const out = extractUsdcTransfers(
      {
        ...base, type: 'invoke_host_function',
        asset_balance_changes: [
          { type: 'transfer', from: A, to: A, amount: '9', asset_code: 'USDC', asset_issuer: USDC_ISSUER.pubnet },
          { type: 'transfer', from: A, to: B, amount: '4', asset_code: 'USDC', asset_issuer: USDC_ISSUER.pubnet },
        ],
      },
      PIN,
    );
    expect(out.map((t) => [t.to, t.amount])).toEqual([[B, 4]]);
  });
});
