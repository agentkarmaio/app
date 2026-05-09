/// <reference types="bun-types" />
/**
 * Slot 4 — wallet-scan TDARS tests.
 *
 * These tests are written BEFORE the implementation lands. They will fail with
 * import / undefined errors until Slot 4 ships:
 *   - extractX402PaymentForWallet()  (refactored extraction in helius.ts)
 *   - scanWalletHistory()            (new module wallet-scan.ts)
 *   - runWalletScanWorker()          (new module wallet-scan.ts)
 *
 * Run: bun test src/indexer/wallet-scan.test.ts
 *
 * Mock strategy chosen: DEPENDENCY INJECTION (not mock.module).
 *   The `scanWalletHistory(wallet, opts)` surface MUST accept injected
 *   `connection` and `parseTransactionsBatch` so tests can drive control flow
 *   deterministically. This keeps the production import graph untouched and
 *   matches the project rule "no mocks/hardcoded data unless requested".
 *   Slot 4 — please expose:
 *     opts.getSignaturesForAddress?: (
 *       wallet: string,
 *       opts: { before?: string; limit: number },
 *     ) => Promise<Array<{ signature: string }>>;
 *     opts.parseTransactionsBatch?: (sigs: string[]) => Promise<HeliusEnhancedTransaction[]>;
 *     opts.insertTransactions?:    (txs: Array<Omit<Transaction, 'id'>>) => Promise<number>;
 *     opts.recordPayshSignal?:     (signal: PayshExtractedPayment) => Promise<void>;
 *   Production code keeps its own defaults; tests pass stubs.
 */

import { describe, expect, test } from 'bun:test';
import type { HeliusEnhancedTransaction } from './helius';
import { extractX402PaymentForWallet } from './helius';
import { scanWalletHistory } from './wallet-scan';
import type { Transaction } from '../db/schema';
import { PAYSH_OPERATORS, type PayshOperator } from '../config/paysh-operators';
import { ALL_FACILITATOR_ADDRESSES } from '../config/facilitators';
import { SPL_TOKEN_PROGRAM, MEMO_PROGRAM } from './paysh-fingerprint';

// ─── Constants ───────────────────────────────────────────────────────────────

const PAYER = '3rGu9hPHdgwR8KeZTpPkN4Z5VRBeR3LBs9CAnqJ7yDjZ';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const COINBASE_FACILITATOR = 'L54zkaPQFeTn1UsEqieEXBqWrPShiaZEPD7mS5WXfQg';
const NON_FACILITATOR = 'NotAFacilitator11111111111111111111111111111';
const FACILITATOR_SET: ReadonlySet<string> = new Set(ALL_FACILITATOR_ADDRESSES);

const GOOGLE: PayshOperator = PAYSH_OPERATORS['google-cloud-apis'];

// ─── Synthetic factories ─────────────────────────────────────────────────────

function makeBaseTx(overrides?: Partial<HeliusEnhancedTransaction>): HeliusEnhancedTransaction {
  return {
    description: '',
    type: 'TRANSFER',
    source: 'SYSTEM_PROGRAM',
    fee: 5000,
    feePayer: PAYER,
    signature: 'TESTSIG_' + Math.random().toString(36).slice(2, 10),
    slot: 1,
    timestamp: Math.floor(Date.now() / 1000),
    nativeTransfers: [],
    tokenTransfers: [],
    accountData: [],
    transactionError: null,
    events: {},
    ...overrides,
  };
}

function makeX402Tx(
  payer: string,
  facilitator: string,
  amount: number,
): HeliusEnhancedTransaction {
  return {
    ...makeBaseTx({ feePayer: payer }),
    tokenTransfers: [
      {
        fromUserAccount: payer,
        toUserAccount: facilitator,
        fromTokenAccount: 'fromAta',
        toTokenAccount: 'toAta',
        tokenAmount: amount,
        mint: USDC,
        tokenStandard: 'Fungible',
      },
    ],
  };
}

function makeVanillaSolTransferTx(): HeliusEnhancedTransaction {
  return {
    ...makeBaseTx({ feePayer: PAYER }),
    nativeTransfers: [
      {
        fromUserAccount: PAYER,
        toUserAccount: NON_FACILITATOR,
        amount: 100_000,
      },
    ],
  };
}

function makeNoiseTx(): HeliusEnhancedTransaction {
  // USDC transfer where counterparty is NOT a facilitator. Should produce no hit.
  return {
    ...makeBaseTx({ feePayer: PAYER }),
    tokenTransfers: [
      {
        fromUserAccount: PAYER,
        toUserAccount: NON_FACILITATOR,
        fromTokenAccount: 'fromAta',
        toTokenAccount: 'toAta',
        tokenAmount: 0.5,
        mint: USDC,
        tokenStandard: 'Fungible',
      },
    ],
  };
}

function makeFullPayshTx(): HeliusEnhancedTransaction & {
  signers?: string[];
  instructions?: Array<{ programId: string; data?: string; accounts?: string[] }>;
} {
  return {
    ...makeBaseTx({ feePayer: GOOGLE.feePayer }),
    tokenTransfers: [
      {
        fromUserAccount: PAYER,
        toUserAccount: GOOGLE.recipient,
        fromTokenAccount: 'fromAta',
        toTokenAccount: 'toAta1',
        tokenAmount: 1.0,
        mint: USDC,
        tokenStandard: 'Fungible',
      },
      {
        fromUserAccount: PAYER,
        toUserAccount: GOOGLE.feePayer,
        fromTokenAccount: 'fromAta',
        toTokenAccount: 'toAta2',
        tokenAmount: 0.05,
        mint: USDC,
        tokenStandard: 'Fungible',
      },
    ],
    signers: [PAYER],
    instructions: [
      { programId: SPL_TOKEN_PROGRAM, data: 'spl1' },
      { programId: SPL_TOKEN_PROGRAM, data: 'spl2' },
      { programId: MEMO_PROGRAM, data: 'Operator fee' },
      { programId: MEMO_PROGRAM, data: 'Platform fee' },
    ],
  };
}

// ─── 1. extractX402PaymentForWallet — pure unit tests ───────────────────────

describe('extractX402PaymentForWallet', () => {
  test('x402 hit on known facilitator counterparty returns payment with payer wallet', () => {
    const tx = makeX402Tx(PAYER, COINBASE_FACILITATOR, 0.05);
    const result = extractX402PaymentForWallet(tx, PAYER, FACILITATOR_SET);
    expect(result).not.toBeNull();
    expect(result!.facilitator).toBe(COINBASE_FACILITATOR);
    expect(result!.payment.wallet_address).toBe(PAYER);
    expect(result!.payment.amount).toBe(0.05);
    expect(result!.payment.tx_signature).toBe(tx.signature);
    expect(result!.payment.success).toBe(true);
  });

  test('returns null when wallet does not appear in tokenTransfers', () => {
    const otherWallet = 'OtherWallet111111111111111111111111111111111';
    const tx = makeX402Tx(otherWallet, COINBASE_FACILITATOR, 0.05);
    const result = extractX402PaymentForWallet(tx, PAYER, FACILITATOR_SET);
    expect(result).toBeNull();
  });

  test('returns null when counterparty is NOT in facilitatorSet', () => {
    const tx = makeX402Tx(PAYER, NON_FACILITATOR, 0.05);
    const result = extractX402PaymentForWallet(tx, PAYER, FACILITATOR_SET);
    expect(result).toBeNull();
  });

  test('returns null when transactionError is non-null', () => {
    const tx = makeX402Tx(PAYER, COINBASE_FACILITATOR, 0.05);
    tx.transactionError = 'InsufficientFunds';
    const result = extractX402PaymentForWallet(tx, PAYER, FACILITATOR_SET);
    expect(result).toBeNull();
  });

  test('USDC transfer from wallet to facilitator emits payment with correct amount', () => {
    const tx = makeX402Tx(PAYER, COINBASE_FACILITATOR, 1.234567);
    const result = extractX402PaymentForWallet(tx, PAYER, FACILITATOR_SET);
    expect(result).not.toBeNull();
    expect(result!.payment.amount).toBe(1.234567);
    expect(result!.payment.wallet_address).toBe(PAYER);
    expect(result!.facilitator).toBe(COINBASE_FACILITATOR);
  });
});

// ─── 2. scanWalletHistory — termination ──────────────────────────────────────

describe('scanWalletHistory — termination', () => {
  test('empty signature list → scanned=0, hits=0, no Helius call', async () => {
    let parseCalls = 0;
    const result = await scanWalletHistory(PAYER, {
      pageSize: 1000,
      maxSignatures: 2000,
      noiseFloorPages: 5,
      getSignaturesForAddress: async () => [],
      parseTransactionsBatch: async () => {
        parseCalls++;
        return [];
      },
      insertTransactions: async () => 0,
      recordPayshSignal: async () => {},
    });
    expect(result.scanned).toBe(0);
    expect(result.hits).toBe(0);
    expect(result.reachedCap).toBe(false);
    expect(parseCalls).toBe(0);
  });

  test('5 consecutive zero-hit pages of 1000 sigs → terminates at noiseFloor', async () => {
    let parseCalls = 0;
    let pageIdx = 0;
    const result = await scanWalletHistory(PAYER, {
      pageSize: 1000,
      maxSignatures: 10000,
      noiseFloorPages: 5,
      getSignaturesForAddress: async () => {
        if (pageIdx >= 6) return []; // after noise floor, should never get called
        pageIdx++;
        return Array.from({ length: 1000 }, (_, i) => ({
          signature: `noise_${pageIdx}_${i}`,
        }));
      },
      parseTransactionsBatch: async (sigs: string[]) => {
        parseCalls++;
        // All noise — none hit a facilitator.
        return sigs.map(() => makeNoiseTx());
      },
      insertTransactions: async () => 0,
      recordPayshSignal: async () => {},
    });
    expect(result.hits).toBe(0);
    expect(result.scanned).toBe(5000);
    expect(result.reachedCap).toBe(false);
    // Should have stopped fetching after 5 zero-hit pages.
    expect(pageIdx).toBe(5);
  });

  test('2000-sig hard cap → terminates at scanned=2000, reachedCap=true', async () => {
    let pageIdx = 0;
    const result = await scanWalletHistory(PAYER, {
      pageSize: 1000,
      maxSignatures: 2000,
      noiseFloorPages: 100, // disable noise floor so cap is the limit
      getSignaturesForAddress: async () => {
        pageIdx++;
        // Always return a full page so cap kicks in.
        return Array.from({ length: 1000 }, (_, i) => ({
          signature: `cap_${pageIdx}_${i}`,
        }));
      },
      // Every tx is a hit so noise-floor doesn't trip.
      parseTransactionsBatch: async (sigs: string[]) =>
        sigs.map(() => makeX402Tx(PAYER, COINBASE_FACILITATOR, 0.01)),
      insertTransactions: async (rows: Array<Omit<Transaction, 'id'>>) => rows.length,
      recordPayshSignal: async () => {},
    });
    expect(result.scanned).toBe(2000);
    expect(result.reachedCap).toBe(true);
  });

  test('page returns < pageSize → terminates (history exhausted)', async () => {
    let pageIdx = 0;
    const result = await scanWalletHistory(PAYER, {
      pageSize: 1000,
      maxSignatures: 10000,
      noiseFloorPages: 100,
      getSignaturesForAddress: async () => {
        pageIdx++;
        if (pageIdx === 1) {
          return Array.from({ length: 250 }, (_, i) => ({
            signature: `partial_${i}`,
          }));
        }
        return [];
      },
      parseTransactionsBatch: async (sigs: string[]) =>
        sigs.map(() => makeNoiseTx()),
      insertTransactions: async () => 0,
      recordPayshSignal: async () => {},
    });
    expect(result.scanned).toBe(250);
    expect(result.reachedCap).toBe(false);
    // exactly one page fetched
    expect(pageIdx).toBe(1);
  });
});

// ─── 3. scanWalletHistory — idempotency ──────────────────────────────────────

describe('scanWalletHistory — idempotency', () => {
  test('same tx parsed twice on resume → insertTransactions called with same row both times', async () => {
    const insertCalls: Array<Array<Omit<Transaction, 'id'>>> = [];
    const inputSig = 'idempotent_sig_abc';
    const tx: HeliusEnhancedTransaction = {
      ...makeX402Tx(PAYER, COINBASE_FACILITATOR, 0.7),
      signature: inputSig,
    };

    const runOnce = async () => {
      let pageIdx = 0;
      return scanWalletHistory(PAYER, {
        pageSize: 1000,
        maxSignatures: 2000,
        noiseFloorPages: 5,
        getSignaturesForAddress: async () => {
          pageIdx++;
          if (pageIdx === 1) return [{ signature: inputSig }];
          return [];
        },
        parseTransactionsBatch: async () => [tx],
        insertTransactions: async (rows: Array<Omit<Transaction, 'id'>>) => {
          insertCalls.push(rows);
          // Real Supabase upsert with onConflict ignoreDuplicates returns 0 on
          // duplicate. Simulate by returning rows.length on first call, 0 on
          // resume.
          return insertCalls.length === 1 ? rows.length : 0;
        },
        recordPayshSignal: async () => {},
      });
    };

    const first = await runOnce();
    const second = await runOnce();

    // Both runs scan the same single sig → both call insertTransactions with
    // the same row payload. Dedup happens at the DB layer (tx_signature unique).
    expect(insertCalls.length).toBe(2);
    expect(insertCalls[0].length).toBe(1);
    expect(insertCalls[1].length).toBe(1);
    expect(insertCalls[0][0].tx_signature).toBe(inputSig);
    expect(insertCalls[1][0].tx_signature).toBe(inputSig);
    expect(insertCalls[0][0].wallet_address).toBe(PAYER);
    expect(insertCalls[1][0].wallet_address).toBe(PAYER);

    expect(first.hits).toBe(1);
    expect(second.hits).toBe(1);
  });
});

// ─── 4. scanWalletHistory — known facilitator hit + paysh ────────────────────

describe('scanWalletHistory — known facilitator hit', () => {
  test('page with x402 + paysh + vanilla → 1 transaction insert + 1 paysh signal', async () => {
    const inserted: Array<Omit<Transaction, 'id'>> = [];
    const payshSignals: unknown[] = [];

    const x402 = makeX402Tx(PAYER, COINBASE_FACILITATOR, 0.05);
    const paysh = makeFullPayshTx();
    const vanilla = makeVanillaSolTransferTx();

    let pageIdx = 0;
    const result = await scanWalletHistory(PAYER, {
      pageSize: 1000,
      maxSignatures: 2000,
      noiseFloorPages: 5,
      getSignaturesForAddress: async () => {
        pageIdx++;
        if (pageIdx === 1) {
          return [
            { signature: x402.signature },
            { signature: paysh.signature },
            { signature: vanilla.signature },
          ];
        }
        return [];
      },
      parseTransactionsBatch: async (sigs: string[]) => {
        const map = new Map<string, HeliusEnhancedTransaction>([
          [x402.signature, x402],
          [paysh.signature, paysh],
          [vanilla.signature, vanilla],
        ]);
        return sigs.map((s) => map.get(s)!).filter(Boolean);
      },
      insertTransactions: async (rows: Array<Omit<Transaction, 'id'>>) => {
        inserted.push(...rows);
        return rows.length;
      },
      recordPayshSignal: async (sig: unknown) => {
        payshSignals.push(sig);
      },
    });

    expect(result.scanned).toBe(3);
    expect(result.hits).toBeGreaterThanOrEqual(1);
    // Exactly one x402 transaction row inserted (the paysh tx is NOT an x402
    // hit because GOOGLE's recipient/feePayer aren't in the facilitator set).
    expect(inserted.length).toBe(1);
    expect(inserted[0].wallet_address).toBe(PAYER);
    expect(inserted[0].facilitator).toBe(COINBASE_FACILITATOR);
    expect(inserted[0].amount).toBe(0.05);
    // Exactly one paysh signal recorded.
    expect(payshSignals.length).toBe(1);
  });
});

// ─── 5. Integration — guard rail ─────────────────────────────────────────────

describe('scanWalletHistory — runtime integration', () => {
  test.skip('end-to-end against real Helius + Supabase', async () => {
    // integration: requires Slot 4 + DB + HELIUS_RPC_URL env var
  });
});
