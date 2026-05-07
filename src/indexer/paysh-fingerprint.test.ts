/// <reference types="bun-types" />
/**
 * Unit tests for detectPayshRouted (sprint A1).
 *
 * Run: bun test src/indexer/paysh-fingerprint.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { detectPayshRouted, SPL_TOKEN_PROGRAM, MEMO_PROGRAM } from './paysh-fingerprint';
import type { HeliusEnhancedTransaction } from './helius';
import { PAYSH_OPERATORS, type PayshOperator } from '../config/paysh-operators';
import { calculateScore } from '../scoring';

const GOOGLE: PayshOperator = PAYSH_OPERATORS['google-cloud-apis'];
const PAYSPONGE: PayshOperator = PAYSH_OPERATORS['paysponge'];

const PAYER = '3rGu9hPHdgwR8KeZTpPkN4Z5VRBeR3LBs9CAnqJ7yDjZ'; // arbitrary base58
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function makeBaseTx(): HeliusEnhancedTransaction {
  return {
    description: '',
    type: 'TRANSFER',
    source: 'SYSTEM_PROGRAM',
    fee: 5000,
    feePayer: GOOGLE.feePayer,
    signature: 'TESTSIG_' + Math.random().toString(36).slice(2, 10),
    slot: 1,
    timestamp: Math.floor(Date.now() / 1000),
    nativeTransfers: [],
    tokenTransfers: [],
    accountData: [],
    transactionError: null,
    events: {},
  };
}

function makeFullPayshTx(operator: PayshOperator = GOOGLE): HeliusEnhancedTransaction & {
  signers?: string[];
  instructions?: Array<{ programId: string; data?: string; accounts?: string[] }>;
} {
  return {
    ...makeBaseTx(),
    feePayer: operator.feePayer,
    // Multi-split: payer → recipient + payer → fee payer
    tokenTransfers: [
      {
        fromUserAccount: PAYER,
        toUserAccount: operator.recipient,
        fromTokenAccount: 'fromAta',
        toTokenAccount: 'toAta1',
        tokenAmount: 1.0,
        mint: USDC,
        tokenStandard: 'Fungible',
      },
      {
        fromUserAccount: PAYER,
        toUserAccount: operator.feePayer,
        fromTokenAccount: 'fromAta',
        toTokenAccount: 'toAta2',
        tokenAmount: 0.05,
        mint: USDC,
        tokenStandard: 'Fungible',
      },
    ],
    signers: [PAYER], // first signer != feePayer (sponsored gas)
    instructions: [
      { programId: SPL_TOKEN_PROGRAM, data: 'spl1' },
      { programId: SPL_TOKEN_PROGRAM, data: 'spl2' },
      { programId: MEMO_PROGRAM, data: 'Operator fee' },
      { programId: MEMO_PROGRAM, data: 'Platform fee' },
    ],
  };
}

describe('detectPayshRouted', () => {
  test('positive: all four conditions hold for Google Cloud APIs operator', () => {
    const tx = makeFullPayshTx(GOOGLE);
    const result = detectPayshRouted(tx);
    expect(result.isPaysh).toBe(true);
    expect(result.operatorId).toBe('google-cloud-apis');
    expect(result.protocol).toBe('mpp');
    expect(result.conditions.multiSplitTransfer).toBe(true);
    expect(result.conditions.feeMemo).toBe(true);
    expect(result.conditions.sponsoredGas).toBe(true);
    expect(result.conditions.knownOperator).toBe(true);
  });

  test('positive: paysponge operator (hybrid protocol)', () => {
    const tx = makeFullPayshTx(PAYSPONGE);
    const result = detectPayshRouted(tx);
    expect(result.isPaysh).toBe(true);
    expect(result.operatorId).toBe('paysponge');
    expect(result.protocol).toBe('hybrid');
  });

  test('negative: no fee memo', () => {
    const tx = makeFullPayshTx(GOOGLE) as HeliusEnhancedTransaction & {
      instructions?: Array<{ programId: string; data?: string }>;
    };
    tx.instructions = (tx.instructions ?? []).filter((i) => i.programId !== MEMO_PROGRAM);
    const result = detectPayshRouted(tx);
    expect(result.isPaysh).toBe(false);
    expect(result.conditions.feeMemo).toBe(false);
  });

  test('negative: only one transfer (no multi-split)', () => {
    const tx = makeFullPayshTx(GOOGLE);
    tx.tokenTransfers = tx.tokenTransfers.slice(0, 1);
    // Also remove extra spl ix so the fallback scan returns 1.
    const txWithIx = tx as HeliusEnhancedTransaction & {
      instructions?: Array<{ programId: string; data?: string }>;
    };
    txWithIx.instructions = (txWithIx.instructions ?? []).filter(
      (i, idx) => !(i.programId === SPL_TOKEN_PROGRAM && idx >= 1),
    );
    const result = detectPayshRouted(tx);
    expect(result.isPaysh).toBe(false);
    expect(result.conditions.multiSplitTransfer).toBe(false);
  });

  test('negative: feePayer == first signer (no sponsored gas)', () => {
    const tx = makeFullPayshTx(GOOGLE) as HeliusEnhancedTransaction & {
      signers?: string[];
    };
    tx.signers = [GOOGLE.feePayer]; // signer == feePayer → not sponsored
    const result = detectPayshRouted(tx);
    expect(result.isPaysh).toBe(false);
    expect(result.conditions.sponsoredGas).toBe(false);
  });

  test('negative: unknown operator address', () => {
    const tx = makeFullPayshTx(GOOGLE);
    tx.feePayer = 'NotAnOperator11111111111111111111111111111111';
    tx.tokenTransfers = tx.tokenTransfers.map((t) => ({
      ...t,
      toUserAccount: 'NotAnOperator11111111111111111111111111111111',
    }));
    const result = detectPayshRouted(tx);
    expect(result.isPaysh).toBe(false);
    expect(result.conditions.knownOperator).toBe(false);
  });

  test('negative: vanilla x402 facilitator transfer with no memo or split', () => {
    const tx: HeliusEnhancedTransaction = {
      ...makeBaseTx(),
      feePayer: PAYER,
      tokenTransfers: [
        {
          fromUserAccount: PAYER,
          toUserAccount: 'L54zkaPQFeTn1UsEqieEXBqWrPShiaZEPD7mS5WXfQg', // Coinbase facilitator
          fromTokenAccount: 'fromAta',
          toTokenAccount: 'toAta',
          tokenAmount: 0.01,
          mint: USDC,
          tokenStandard: 'Fungible',
        },
      ],
    };
    const result = detectPayshRouted(tx);
    expect(result.isPaysh).toBe(false);
  });
});

describe('calculateScore — backwards compatibility for x402-only wallets', () => {
  // Simulate a typical x402-only wallet's scoring: no pay.sh receipts, normal
  // tx history. Score MUST equal the same call without payshRoutedCount param.
  const fixedNow = Date.now();
  const txs = Array.from({ length: 25 }, (_, i) => ({
    wallet_address: PAYER,
    facilitator: 'L54zkaPQFeTn1UsEqieEXBqWrPShiaZEPD7mS5WXfQg',
    amount: 0.05,
    timestamp: new Date(fixedNow - i * 86_400_000).toISOString(),
    success: true,
    tx_signature: `sig${i}`,
  }));

  test('omitting payshRoutedCount yields identical score to passing 0', () => {
    const noArg = calculateScore(txs, 0, undefined, undefined, null, null);
    const zero  = calculateScore(txs, 0, undefined, undefined, null, null, 0);
    expect(zero.score).toBe(noArg.score);
    expect(zero.providerScore).toBe(noArg.providerScore);
    expect(zero.consumerScore).toBe(noArg.consumerScore);
    expect(zero.confidenceBadge).toBe(noArg.confidenceBadge);
    expect(zero.metrics.attestation).toBe(noArg.metrics.attestation);
    expect(zero.tierAggregates.tier1 ?? null).toBe(noArg.tierAggregates.tier1 ?? null);
  });

  test('passing null payshRoutedCount yields identical score', () => {
    const noArg = calculateScore(txs, 0, undefined, undefined, null, null);
    const nullArg = calculateScore(txs, 0, undefined, undefined, null, null, null);
    expect(nullArg.score).toBe(noArg.score);
  });

  test('pay.sh-routed receipt promotes confidence-badge to receipt-backed', () => {
    const before = calculateScore(txs, 0, undefined, undefined, null, null, 0);
    const after  = calculateScore(txs, 0, undefined, undefined, null, null, 1);
    expect(before.confidenceBadge).not.toBe('receipt-backed');
    expect(after.confidenceBadge).toBe('receipt-backed');
    expect(after.score).toBeGreaterThan(before.score);
  });

  test('pay.sh + 8004 attestation: max-blend, never sum (no double-credit)', () => {
    // Wallet with strong 8004 attestation (=1.0)
    const attOnly  = calculateScore(txs, 1.0, undefined, undefined, null, null, 0);
    // Wallet with strong 8004 + many pay.sh receipts (10 hits)
    const attPaysh = calculateScore(txs, 1.0, undefined, undefined, null, null, 10);
    // tier1 must remain ≤ 1.0 — never doubled.
    expect((attPaysh.tierAggregates.tier1 ?? 0)).toBeLessThanOrEqual(1.0);
    // The score with both signals does not exceed the score with just 1.0 attestation
    // (since both are already at the cap).
    expect(attPaysh.score).toBe(attOnly.score);
  });
});
