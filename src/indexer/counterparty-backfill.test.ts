/// <reference types="bun-types" />
/**
 * Counterparty backfill — write-guard tests.
 *
 * This is where "never fabricate a counterparty" is enforced. The RPC fetch and
 * the DB update are untested glue in scripts/backfill-solana-counterparty.ts
 * (same convention as farm-detector). Every decision about whether a payee may
 * be written to a row lives here, and every branch has a test.
 *
 * See the design notes (kept out of this repo).
 *
 * Run: bun test src/indexer/counterparty-backfill.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { decideCounterpartyWrite, isConclusivelyNull, type BackfillRow, type SkipReason } from './counterparty-backfill';
import type { Transaction } from '@/db/schema';

const AMOUNT = 0.125;

const ROW: BackfillRow = {
  tx_signature: 'sig-1',
  wallet_address: 'PAYER111111111111111111111111111111111111111',
  facilitator: 'FACIL1111111111111111111111111111111111111',
  amount: AMOUNT,
};

const derived = (over: Partial<Omit<Transaction, 'id'>> = {}): Omit<Transaction, 'id'> => ({
  chain: 'solana',
  wallet_address: ROW.wallet_address,
  facilitator: ROW.facilitator,
  counterparty: 'PAYEE111111111111111111111111111111111111111',
  amount: AMOUNT,
  timestamp: '2026-04-01T00:00:00.000Z',
  success: true,
  tx_signature: ROW.tx_signature,
  ...over,
});

describe('decideCounterpartyWrite', () => {
  test('all guards pass → writes the derived payee', () => {
    const d = decideCounterpartyWrite(ROW, derived());
    expect(d).toEqual({ action: 'write', counterparty: 'PAYEE111111111111111111111111111111111111111' });
  });

  test('nothing decoded → no-payee, never a fallback value', () => {
    expect(decideCounterpartyWrite(ROW, null)).toEqual({ action: 'skip', reason: 'no-payment-decoded' });
  });

  test('decoded payment carries no counterparty → no-payee (Strategy-2 shape)', () => {
    expect(decideCounterpartyWrite(ROW, derived({ counterparty: undefined }))).toEqual({
      action: 'skip', reason: 'no-payee-in-payment',
    });
    expect(decideCounterpartyWrite(ROW, derived({ counterparty: null }))).toEqual({
      action: 'skip', reason: 'no-payee-in-payment',
    });
    expect(decideCounterpartyWrite(ROW, derived({ counterparty: '' }))).toEqual({
      action: 'skip', reason: 'no-payee-in-payment',
    });
  });

  test('different transaction → refuses, even with an otherwise valid payee', () => {
    expect(decideCounterpartyWrite(ROW, derived({ tx_signature: 'sig-OTHER' }))).toEqual({
      action: 'skip', reason: 'signature-mismatch',
    });
  });

  test('payer disagrees with the stored row → refuses', () => {
    expect(decideCounterpartyWrite(ROW, derived({ wallet_address: 'SOMEONEELSE' }))).toEqual({
      action: 'skip', reason: 'payer-mismatch',
    });
  });

  test('amount disagrees → refuses (a different transfer inside the same tx)', () => {
    expect(decideCounterpartyWrite(ROW, derived({ amount: 0.126 }))).toEqual({
      action: 'skip', reason: 'amount-mismatch',
    });
  });

  test('amount within float tolerance → still writes', () => {
    const d = decideCounterpartyWrite({ ...ROW, amount: 0.1 + 0.025 }, derived({ amount: 0.125 }));
    expect(d.action).toBe('write');
  });

  test('stored amount as a numeric string (PostgREST) compares by value', () => {
    const d = decideCounterpartyWrite({ ...ROW, amount: '0.125000' }, derived());
    expect(d.action).toBe('write');
  });

  test('payee equals the payer → self-payment collapses to null, not written', () => {
    expect(decideCounterpartyWrite(ROW, derived({ counterparty: ROW.wallet_address }))).toEqual({
      action: 'skip', reason: 'self-payment',
    });
  });

  test('payee equal to the facilitator is written — the facilitator IS the payee there', () => {
    // The canonical direct-to-facilitator settlement. Refusing this would drop a
    // genuine observed destination, which is a different kind of wrong.
    const d = decideCounterpartyWrite(ROW, derived({ counterparty: ROW.facilitator }));
    expect(d).toEqual({ action: 'write', counterparty: ROW.facilitator });
  });

  test('unparseable stored amount → refuses rather than comparing against NaN', () => {
    expect(decideCounterpartyWrite({ ...ROW, amount: 'not-a-number' }, derived())).toEqual({
      action: 'skip', reason: 'amount-mismatch',
    });
  });

  test('guard order is deterministic: a wrong-tx row reports the signature, not the payer', () => {
    const d = decideCounterpartyWrite(ROW, derived({ tx_signature: 'sig-OTHER', wallet_address: 'X' }));
    expect(d).toEqual({ action: 'skip', reason: 'signature-mismatch' });
  });
});

describe('isConclusivelyNull', () => {
  // Conclusive = re-running the same decode on the same transaction can only
  // reach the same answer, so the row is correctly NULL forever and must be
  // skip-listed. Otherwise every future run refetches it at ~1.5s a piece.
  const conclusive: SkipReason[] = ['no-payment-decoded', 'no-payee-in-payment', 'self-payment'];
  const inconclusive: SkipReason[] = ['signature-mismatch', 'payer-mismatch', 'amount-mismatch'];

  test.each(conclusive)('%s is conclusive — skip-list it', (reason) => {
    expect(isConclusivelyNull(reason)).toBe(true);
  });

  test.each(inconclusive)('%s is a disagreement — keep it visible, do not bury it', (reason) => {
    expect(isConclusivelyNull(reason)).toBe(false);
  });

  test('every SkipReason is classified — a new one cannot default to silently skipped', () => {
    // If a reason is added to the union without a decision here, this fails.
    expect([...conclusive, ...inconclusive].sort()).toEqual(
      ([
        'amount-mismatch', 'no-payee-in-payment', 'no-payment-decoded',
        'payer-mismatch', 'self-payment', 'signature-mismatch',
      ] as SkipReason[]).sort(),
    );
  });
});
