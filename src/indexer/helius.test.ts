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

import { afterEach, describe, expect, test } from 'bun:test';
import type { HeliusEnhancedTransaction } from './helius';
import {
  mapParsedTxToEnhanced,
  extractX402Payment,
  getIndexerRpcUrl,
  getArchiveRpcUrl,
  parseWithArchiveFallback,
} from './helius';
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
  // Restore in a hook, never in trailing statements after the expect: a failing
  // assertion skips those, and bun runs every test file in ONE process, so the
  // fakes below would leak into whichever file happens to run next.
  const savedSol = process.env.SOLANA_RPC_URL;
  const savedHel = process.env.HELIUS_RPC_URL;
  afterEach(() => {
    if (savedSol === undefined) delete process.env.SOLANA_RPC_URL;
    else process.env.SOLANA_RPC_URL = savedSol;
    if (savedHel === undefined) delete process.env.HELIUS_RPC_URL;
    else process.env.HELIUS_RPC_URL = savedHel;
  });

  test('falls back to public mainnet-beta when no RPC env is set', () => {
    delete process.env.SOLANA_RPC_URL;
    delete process.env.HELIUS_RPC_URL;
    expect(getIndexerRpcUrl()).toBe('https://api.mainnet-beta.solana.com');
  });

  test('prefers SOLANA_RPC_URL (free RPC) over Helius', () => {
    process.env.SOLANA_RPC_URL = 'https://free.example/rpc';
    process.env.HELIUS_RPC_URL = 'https://helius/?api-key=k';
    expect(getIndexerRpcUrl()).toBe('https://free.example/rpc');
  });
});

// ─── Parse accounting + archive fallback ─────────────────────────────────────
// THE BUG (2026-09-10): parseTransactionsBatch did `if (!tx) continue;` — a
// signature the RPC could not serve was dropped with no error and no counter,
// and its caller advanced the cursor past it anyway. `unresolved` is what makes
// a lossy run impossible to report as clean.
// Spec: (design notes, kept out of this repo)
describe('parseWithArchiveFallback', () => {
  const SIGS = ['sigA', 'sigB', 'sigC'];
  const found = (sig: string) => usdcPaymentTx() as ParsedTransactionWithMeta & { __sig?: string };
  const never = async () => null;

  test('all served by the primary: nothing unresolved, archive untouched', async () => {
    let archiveCalls = 0;
    const r = await parseWithArchiveFallback(
      SIGS,
      async (sig) => found(sig),
      async () => { archiveCalls++; return null; },
    );
    expect(r.transactions).toHaveLength(3);
    expect(r.requested).toBe(3);
    expect(r.unresolved).toEqual([]);
    expect(r.recoveredFromArchive).toBe(0);
    expect(archiveCalls).toBe(0);
  });

  test('primary null + archive FOUND → decoded, and NOT counted as lost', async () => {
    const r = await parseWithArchiveFallback(
      SIGS,
      async (sig) => (sig === 'sigB' ? null : found(sig)),
      async (sig) => found(sig),
    );
    expect(r.transactions).toHaveLength(3);
    expect(r.unresolved).toEqual([]);
    expect(r.recoveredFromArchive).toBe(1);
  });

  test('null on BOTH endpoints → reported unresolved, not silently skipped', async () => {
    const r = await parseWithArchiveFallback(
      SIGS,
      async (sig) => (sig === 'sigB' ? null : found(sig)),
      never,
    );
    expect(r.transactions).toHaveLength(2);
    expect(r.unresolved).toEqual(['sigB']);
    expect(r.recoveredFromArchive).toBe(0);
  });

  test('a THROWING primary fetch is unresolved, not "decoded nothing"', async () => {
    const r = await parseWithArchiveFallback(
      SIGS,
      async (sig) => { if (sig === 'sigC') throw new Error('fetch failed'); return found(sig); },
      never,
    );
    expect(r.unresolved).toEqual(['sigC']);
    expect(r.undecodable).toBe(0);
  });

  test('fetched but meta-less → undecodable, NOT unresolved (cursor may pass)', async () => {
    const noMeta = { slot: 1, blockTime: 1, transaction: { message: { accountKeys: [] } }, meta: null } as unknown as ParsedTransactionWithMeta;
    const r = await parseWithArchiveFallback(
      ['sigA'],
      async () => noMeta,
      never,
    );
    expect(r.undecodable).toBe(1);
    expect(r.unresolved).toEqual([]);   // retrying can never help; do not wedge on it
    expect(r.transactions).toHaveLength(0);
  });

  test('no archive endpoint configured → primary misses stay unresolved', async () => {
    const r = await parseWithArchiveFallback(SIGS, never, null);
    expect(r.unresolved).toEqual(SIGS);
    expect(r.transactions).toHaveLength(0);
  });

  test('archive budget caps the retries; the remainder stays unresolved', async () => {
    const many = ['s0', 's1', 's2', 's3', 's4'];
    let archiveCalls = 0;
    const r = await parseWithArchiveFallback(
      many,
      never,
      async (sig) => { archiveCalls++; return found(sig); },
      2,
    );
    expect(archiveCalls).toBe(2);
    expect(r.recoveredFromArchive).toBe(2);
    // Budget spends OLDEST-first (input is newest-first): the deepest signatures
    // are the ones that unblock the cursor.
    expect(r.unresolved).toEqual(['s0', 's1', 's2']);
  });

  test('empty input is a no-op, not a fetch', async () => {
    let calls = 0;
    const r = await parseWithArchiveFallback([], async () => { calls++; return null; }, null);
    expect(r).toEqual({ transactions: [], requested: 0, unresolved: [], undecodable: 0, recoveredFromArchive: 0 });
    expect(calls).toBe(0);
  });
});

describe('getArchiveRpcUrl', () => {
  const saved = process.env.SOLANA_ARCHIVE_RPC_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.SOLANA_ARCHIVE_RPC_URL;
    else process.env.SOLANA_ARCHIVE_RPC_URL = saved;
  });

  test('defaults to public mainnet-beta (measured ≥300d retention)', () => {
    delete process.env.SOLANA_ARCHIVE_RPC_URL;
    expect(getArchiveRpcUrl()).toBe('https://api.mainnet-beta.solana.com');
  });

  test('honors an explicit archive endpoint', () => {
    process.env.SOLANA_ARCHIVE_RPC_URL = 'https://archive.example/rpc';
    expect(getArchiveRpcUrl()).toBe('https://archive.example/rpc');
  });
});

// An unset GitHub Actions secret arrives as an EMPTY STRING, and `??` accepts
// it — `new Connection('')` then throws instead of falling back. Both RPC
// resolvers read env vars that keep-fresh.yml supplies as secrets.
describe('RPC resolvers treat an empty env var as unset (CI secret trap)', () => {
  const saved = {
    sol: process.env.SOLANA_RPC_URL,
    hel: process.env.HELIUS_RPC_URL,
    arch: process.env.SOLANA_ARCHIVE_RPC_URL,
  };
  afterEach(() => {
    for (const [key, value] of [
      ['SOLANA_RPC_URL', saved.sol],
      ['HELIUS_RPC_URL', saved.hel],
      ['SOLANA_ARCHIVE_RPC_URL', saved.arch],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('empty SOLANA_RPC_URL falls through to Helius, then to mainnet-beta', () => {
    process.env.SOLANA_RPC_URL = '';
    process.env.HELIUS_RPC_URL = 'https://helius/?api-key=k';
    expect(getIndexerRpcUrl()).toBe('https://helius/?api-key=k');

    process.env.HELIUS_RPC_URL = '   ';
    expect(getIndexerRpcUrl()).toBe('https://api.mainnet-beta.solana.com');
  });

  test('empty SOLANA_ARCHIVE_RPC_URL falls back to mainnet-beta', () => {
    process.env.SOLANA_ARCHIVE_RPC_URL = '';
    expect(getArchiveRpcUrl()).toBe('https://api.mainnet-beta.solana.com');
  });
});

// The archive endpoint (public mainnet-beta) 429s under light load, and
// fetchAllX402Transactions runs 5 facilitators in parallel — each with its own
// retry loop. A per-batch limit of 1 would still put 5 calls in flight, so the
// serialization has to be process-wide.
describe('archive retries are serialized process-wide, not per batch', () => {
  test('two concurrent batches never put 2 archive calls in flight', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const archive = async (sig: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return usdcPaymentTx() as ParsedTransactionWithMeta;
    };
    const primaryMisses = async () => null;

    const [a, b] = await Promise.all([
      parseWithArchiveFallback(['a1', 'a2', 'a3'], primaryMisses, archive),
      parseWithArchiveFallback(['b1', 'b2', 'b3'], primaryMisses, archive),
    ]);

    expect(maxInFlight).toBe(1);
    expect(a.recoveredFromArchive).toBe(3);
    expect(b.recoveredFromArchive).toBe(3);
  });

  test('a throwing archive call does not wedge the queue for later callers', async () => {
    const boom = await parseWithArchiveFallback(
      ['x'],
      async () => null,
      async () => { throw new Error('429 Too Many Requests'); },
    );
    expect(boom.unresolved).toEqual(['x']);

    const after = await parseWithArchiveFallback(
      ['y'],
      async () => null,
      async () => usdcPaymentTx() as ParsedTransactionWithMeta,
    );
    expect(after.recoveredFromArchive).toBe(1);
  });
});
