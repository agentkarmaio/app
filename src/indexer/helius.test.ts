/// <reference types="bun-types" />
/**
 * Helius-free parsing — standard-RPC `getParsedTransaction` → enhanced shape.
 *
 * Option 2: the indexer no longer calls the credit-heavy Helius Enhanced
 * Transactions API. `mapParsedTxToEnhanced` reconstructs the same shape the
 * extractors consume from `meta.pre/postTokenBalances` deltas, so x402 payments
 * decode identically off a free RPC. These tests pin that round-trip:
 * standard parsed tx → enhanced map → extractX402Payment → AK transaction row.
 *
 * Run: bun test src/indexer/helius.test.ts
 */

import { describe, expect, test } from 'bun:test';
import type { HeliusEnhancedTransaction } from './helius';
import { mapParsedTxToEnhanced, extractX402Payment, getIndexerRpcUrl } from './helius';
import { USDC_MINT } from '../config/facilitators';
import type { ParsedTransactionWithMeta } from '@solana/web3.js';

const PAYER = 'PayerWa11et1111111111111111111111111111111';
const FACIL = 'Faci1itator22222222222222222222222222222222';
const PAYER_ATA = 'PayerTokenAcct333333333333333333333333333333';
const FACIL_ATA = 'Faci1TokenAcct44444444444444444444444444444';
const PAYEE = 'Payee99999999999999999999999999999999999999';

const mkKey = (s: string) => ({ pubkey: { toString: () => s }, signer: true, writable: true });

/** A 1.5-USDC payment from PAYER → FACIL, as a standard getParsedTransaction. */
function usdcPaymentTx(opts: { err?: unknown } = {}): ParsedTransactionWithMeta {
  return {
    slot: 1234,
    blockTime: 1_750_000_000,
    transaction: {
      message: { accountKeys: [mkKey(PAYER), mkKey(PAYER_ATA), mkKey(FACIL_ATA)] },
      signatures: ['sigABC'],
    },
    meta: {
      err: opts.err ?? null,
      fee: 5000,
      preTokenBalances: [
        { accountIndex: 1, mint: USDC_MINT, owner: PAYER, uiTokenAmount: { amount: '10000000', decimals: 6, uiAmount: 10 } },
        { accountIndex: 2, mint: USDC_MINT, owner: FACIL, uiTokenAmount: { amount: '0', decimals: 6, uiAmount: 0 } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: USDC_MINT, owner: PAYER, uiTokenAmount: { amount: '8500000', decimals: 6, uiAmount: 8.5 } },
        { accountIndex: 2, mint: USDC_MINT, owner: FACIL, uiTokenAmount: { amount: '1500000', decimals: 6, uiAmount: 1.5 } },
      ],
    },
  } as unknown as ParsedTransactionWithMeta;
}

describe('mapParsedTxToEnhanced', () => {
  test('reconstructs tokenTransfers (payer→payee) from balance deltas', () => {
    const e = mapParsedTxToEnhanced(usdcPaymentTx(), 'sigABC')!;
    expect(e).not.toBeNull();
    expect(e.signature).toBe('sigABC');
    expect(e.timestamp).toBe(1_750_000_000);
    expect(e.feePayer).toBe(PAYER);
    expect(e.transactionError).toBeNull();

    const usdc = e.tokenTransfers.filter((t) => t.mint === USDC_MINT);
    expect(usdc.length).toBe(1);
    expect(usdc[0].fromUserAccount).toBe(PAYER);
    expect(usdc[0].toUserAccount).toBe(FACIL);
    expect(usdc[0].tokenAmount).toBeCloseTo(1.5, 9);
  });

  test('reconstructs accountData.tokenBalanceChanges with signed raw deltas', () => {
    const e = mapParsedTxToEnhanced(usdcPaymentTx(), 'sigABC')!;
    const changes = e.accountData.flatMap((a) => a.tokenBalanceChanges);
    const payer = changes.find((c) => c.userAccount === PAYER)!;
    const payee = changes.find((c) => c.userAccount === FACIL)!;
    expect(payer.rawTokenAmount.tokenAmount).toBe('-1500000'); // tokens left → negative
    expect(payee.rawTokenAmount.tokenAmount).toBe('1500000');
    expect(payer.rawTokenAmount.decimals).toBe(6);
  });

  test('propagates failure: meta.err → non-null transactionError', () => {
    const e = mapParsedTxToEnhanced(usdcPaymentTx({ err: { InstructionError: [0, 'Custom'] } }), 'sigABC')!;
    expect(e.transactionError).not.toBeNull();
  });

  test('returns null when the tx has no meta', () => {
    const noMeta = { slot: 1, blockTime: 1, transaction: { message: { accountKeys: [] } }, meta: null } as unknown as ParsedTransactionWithMeta;
    expect(mapParsedTxToEnhanced(noMeta, 'x')).toBeNull();
  });
});

describe('round-trip: standard parsed tx → extractX402Payment', () => {
  test('extracts payer + amount identically to the Enhanced-API path', () => {
    const e = mapParsedTxToEnhanced(usdcPaymentTx(), 'sigABC')!;
    const payment = extractX402Payment(e, FACIL);
    expect(payment).not.toBeNull();
    expect(payment!.chain).toBe('solana');
    expect(payment!.wallet_address).toBe(PAYER);   // payer is the scored agent
    expect(payment!.facilitator).toBe(FACIL);
    expect(payment!.amount).toBeCloseTo(1.5, 9);
    expect(payment!.success).toBe(true);
    expect(payment!.tx_signature).toBe('sigABC');
  });

  test('a tx with no USDC movement extracts nothing', () => {
    const empty = mapParsedTxToEnhanced(
      { slot: 1, blockTime: 1, transaction: { message: { accountKeys: [mkKey(PAYER)] } }, meta: { err: null, fee: 0, preTokenBalances: [], postTokenBalances: [] } } as unknown as ParsedTransactionWithMeta,
      'sigEmpty',
    )!;
    expect(extractX402Payment(empty, FACIL)).toBeNull();
  });
});

describe('extractX402Payment — counterparty (payee) extraction', () => {
  // Minimal enhanced-tx builder with explicit tokenTransfers (Strategy 1 input).
  function txWithTransfer(opts: {
    from: string;
    to: string;
    amount?: number;
  }): HeliusEnhancedTransaction {
    return {
      description: '', type: 'UNKNOWN', source: 'RPC', fee: 0, feePayer: opts.from,
      signature: 'sigCP', slot: 1, timestamp: 1_750_000_000,
      nativeTransfers: [],
      tokenTransfers: [{
        fromUserAccount: opts.from,
        toUserAccount: opts.to,
        fromTokenAccount: 'fromAta',
        toTokenAccount: 'toAta',
        tokenAmount: opts.amount ?? 1.5,
        mint: USDC_MINT,
        tokenStandard: 'Fungible',
      }],
      accountData: [],
      transactionError: null,
      events: {},
    };
  }

  test('Strategy 1: counterparty = SPL transfer destination, distinct from facilitator', () => {
    // Payer pays a DISTINCT resource-server (PAYEE) on a tx that involves FACIL.
    // The scored wallet is the payer; its true counterparty is the payee it paid,
    // recorded distinctly from the facilitator address being scanned.
    const tx = txWithTransfer({ from: PAYER, to: PAYEE });
    const payment = extractX402Payment(tx, FACIL);
    expect(payment).not.toBeNull();
    expect(payment!.wallet_address).toBe(PAYER);
    expect(payment!.facilitator).toBe(FACIL);
    expect(payment!.counterparty).toBe(PAYEE);
    expect(payment!.counterparty).not.toBe(payment!.facilitator);
  });

  test('Strategy 1: direct-to-facilitator payment → counterparty = facilitator (the genuine payee)', () => {
    // Canonical x402: payer pays the facilitator/resource-server directly. The
    // observed SPL destination IS the facilitator — that is the real payee, not a
    // fabricated value, so counterparty is set to it (equal to facilitator here).
    const tx = txWithTransfer({ from: PAYER, to: FACIL });
    const payment = extractX402Payment(tx, FACIL);
    expect(payment).not.toBeNull();
    expect(payment!.wallet_address).toBe(PAYER);
    expect(payment!.counterparty).toBe(FACIL);
  });

  test('Strategy 2 (balance-change only): no observable payee → counterparty null (not fabricated)', () => {
    // When Helius drops the typed tokenTransfers view, only the debited (payer)
    // account is observable via balance deltas — there is NO recipient field. We
    // MUST NOT fabricate the facilitator as the payee; counterparty stays null.
    const tx: HeliusEnhancedTransaction = {
      description: '', type: 'UNKNOWN', source: 'RPC', fee: 0, feePayer: PAYER,
      signature: 'sigS2', slot: 1, timestamp: 1_750_000_000,
      nativeTransfers: [],
      tokenTransfers: [], // typed view dropped → forces Strategy 2
      accountData: [{
        account: PAYER,
        nativeBalanceChange: 0,
        tokenBalanceChanges: [{
          userAccount: PAYER,
          tokenAccount: 'payerAta',
          mint: USDC_MINT,
          rawTokenAmount: { tokenAmount: '-1500000', decimals: 6 },
        }],
      }],
      transactionError: null,
      events: {},
    };
    const payment = extractX402Payment(tx, FACIL);
    expect(payment).not.toBeNull();
    expect(payment!.wallet_address).toBe(PAYER);
    expect(payment!.facilitator).toBe(FACIL);
    expect(payment!.counterparty ?? null).toBeNull();
  });

  test('round-trip fixture (payer→facilitator) carries counterparty = facilitator', () => {
    const e = mapParsedTxToEnhanced(usdcPaymentTx(), 'sigABC')!;
    const payment = extractX402Payment(e, FACIL);
    // The mapped fixture pays the facilitator directly; counterparty is that payee.
    expect(payment!.counterparty).toBe(FACIL);
  });
});

describe('getIndexerRpcUrl', () => {
  test('falls back to public mainnet-beta when no RPC env is set', () => {
    const prevSol = process.env.SOLANA_RPC_URL;
    const prevHel = process.env.HELIUS_RPC_URL;
    delete process.env.SOLANA_RPC_URL;
    delete process.env.HELIUS_RPC_URL;
    expect(getIndexerRpcUrl()).toBe('https://api.mainnet-beta.solana.com');
    if (prevSol !== undefined) process.env.SOLANA_RPC_URL = prevSol;
    if (prevHel !== undefined) process.env.HELIUS_RPC_URL = prevHel;
  });

  test('prefers SOLANA_RPC_URL (free RPC) over Helius', () => {
    const prevSol = process.env.SOLANA_RPC_URL;
    const prevHel = process.env.HELIUS_RPC_URL;
    process.env.SOLANA_RPC_URL = 'https://free.example/rpc';
    process.env.HELIUS_RPC_URL = 'https://helius/?api-key=k';
    expect(getIndexerRpcUrl()).toBe('https://free.example/rpc');
    if (prevSol !== undefined) process.env.SOLANA_RPC_URL = prevSol; else delete process.env.SOLANA_RPC_URL;
    if (prevHel !== undefined) process.env.HELIUS_RPC_URL = prevHel; else delete process.env.HELIUS_RPC_URL;
  });
});
