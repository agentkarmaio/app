/// <reference types="bun-types" />
/**
 * Solana plain USDC transfer indexer tests.
 *
 * Mock strategy: DEPENDENCY INJECTION, mirroring stellar-transfers.test.ts and
 * arc-transfers.test.ts — no live RPC, no Supabase.
 *
 * The cases that matter here, and why they are not generic:
 *   - THE WRITE GUARD. Five distinct ways a USDC debit is NOT a payment
 *     (swap / burn / self-move / facilitator-routed / failed). Each was
 *     measured or reasoned about in the spec; each gets its own test, because
 *     a guard that collapses two of them into one reason cannot be debugged.
 *   - THE CLOSURE GUARD. `buildSolanaSeedSet` must refuse to seed a payee that
 *     arrived on one of THIS indexer's own rows. Without it the seed grows one
 *     hop per run into a transitive closure over the USDC payment graph.
 *   - THE 12-SIGNATURE CENSUS. `J7aN3PLJnT…`'s complete outbound history was
 *     enumerated on chain 2026-09-10 (12 signatures, 0 RPC misses): 6 payments,
 *     6 distinct payees, 2 of them multi-leg. It is the one end-to-end case
 *     where the correct answer is independently known — the analogue of the
 *     Fianza fixture in stellar-flows.test.ts.
 *
 * Spec: (design notes, kept out of this repo)
 *
 * Run: bun test src/indexer/solana-transfers.test.ts
 */

import { describe, expect, test } from 'bun:test';
import {
  ADDRESS_CONCURRENCY,
  PAGE_SIZE,
  SOLANA_TRANSFER_EXCLUSIONS,
  UNDECLARED_ROUTERS,
  buildSolanaSeedSet,
  classifyUsdcDebit,
  solanaTransfersCursorKey,
  solanaTransfersIndexer,
  toTransactionRow,
  type SolanaTransfersDeps,
} from './solana-transfers';
import { USDC_MINT, ALL_FACILITATOR_ADDRESSES } from '../config/facilitators';
import { ARCHIVE_RETRY_BUDGET, type HeliusEnhancedTransaction } from './helius';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

const WALLET = 'J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg';
const PAYEE_A = 'A6c5Pt1U4mZjnZxLZjQjFqvBQ8oPzYfXWbNqKcTdRuVe';
const PAYEE_B = '5Guq7ooZFtHXwPtLZxCkVnVqYyRmBdTsWjNfEaKuPzGh';
const FACILITATOR = ALL_FACILITATOR_ADDRESSES[0];
const SOL_MINT = 'So11111111111111111111111111111111111111112';

interface Delta {
  owner: string;
  mint: string;
  /** Raw units, signed. Negative = debited. */
  raw: string;
  decimals?: number;
}

/**
 * Build the `mapParsedTxToEnhanced` output shape from a list of balance deltas.
 *
 * Deliberately populates `accountData` and leaves `tokenTransfers` empty: the
 * classifier reads balance deltas, not the paired `tokenTransfers` view, whose
 * sender pairing is a heuristic. Keeping the fixture honest about that means a
 * regression toward the heuristic fails here.
 */
function tx(
  deltas: Delta[],
  opts: { signature?: string; timestamp?: number; error?: string | null } = {},
): HeliusEnhancedTransaction {
  return {
    description: '',
    type: 'UNKNOWN',
    source: 'RPC',
    fee: 5000,
    feePayer: WALLET,
    signature: opts.signature ?? 'sig-default',
    slot: 1,
    timestamp: opts.timestamp ?? 1_756_000_000,
    nativeTransfers: [],
    tokenTransfers: [],
    accountData: deltas.map((d) => ({
      account: d.owner,
      nativeBalanceChange: 0,
      tokenBalanceChanges: [{
        userAccount: d.owner,
        tokenAccount: `${d.owner}-ata`,
        mint: d.mint,
        rawTokenAmount: { tokenAmount: d.raw, decimals: d.decimals ?? 6 },
      }],
    })),
    transactionError: opts.error ?? null,
    events: {},
  };
}

/** A plain payment: wallet debited `amount`, one payee credited the same. */
function payment(payee: string, amount: number, signature: string): HeliusEnhancedTransaction {
  const raw = Math.round(amount * 1e6);
  return tx(
    [
      { owner: WALLET, mint: USDC_MINT, raw: String(-raw) },
      { owner: payee, mint: USDC_MINT, raw: String(raw) },
    ],
    { signature },
  );
}

// ─── The write guard ──────────────────────────────────────────────────────────

describe('classifyUsdcDebit — the write guard', () => {
  test('a plain provider→payee USDC transfer yields a payment', () => {
    const result = classifyUsdcDebit(payment(PAYEE_A, 10, 'sig-1'), WALLET);
    expect(result.action).toBe('row');
    if (result.action !== 'row') throw new Error('unreachable');
    expect(result.counterparty).toBe(PAYEE_A);
    expect(result.amount).toBeCloseTo(10, 6);
    expect(result.multiCredit).toBe(false);
  });

  test('a DEX swap is rejected — the wallet receives a non-USDC token', () => {
    // Wallet debits USDC, credits SOL. The "payee" is a pool vault.
    const result = classifyUsdcDebit(
      tx([
        { owner: WALLET, mint: USDC_MINT, raw: '-25000000' },
        { owner: 'Poo1VauLt11111111111111111111111111111111111', mint: USDC_MINT, raw: '25000000' },
        { owner: WALLET, mint: SOL_MINT, raw: '120000000', decimals: 9 },
      ]),
      WALLET,
    );
    expect(result.action).toBe('skip');
    if (result.action !== 'skip') throw new Error('unreachable');
    expect(result.reason).toBe('swap');
  });

  test('a burn is rejected — no non-owner USDC credit exists', () => {
    const result = classifyUsdcDebit(
      tx([{ owner: WALLET, mint: USDC_MINT, raw: '-5000000' }]),
      WALLET,
    );
    expect(result.action).toBe('skip');
    if (result.action !== 'skip') throw new Error('unreachable');
    expect(result.reason).toBe('no-payee');
  });

  test('a move between the wallet’s own token accounts is rejected as self', () => {
    // Two accounts, same owner: one debited, one credited. Nets to zero.
    const result = classifyUsdcDebit(
      tx([
        { owner: WALLET, mint: USDC_MINT, raw: '-5000000' },
        { owner: WALLET, mint: USDC_MINT, raw: '5000000' },
      ]),
      WALLET,
    );
    expect(result.action).toBe('skip');
    if (result.action !== 'skip') throw new Error('unreachable');
    // Netting to zero means there is no debit at all — the wallet spent nothing.
    expect(result.reason).toBe('no-debit');
  });

  test('a payment to a known facilitator is rejected — it belongs to the x402 path', () => {
    const result = classifyUsdcDebit(payment(FACILITATOR, 2, 'sig-f'), WALLET);
    expect(result.action).toBe('skip');
    if (result.action !== 'skip') throw new Error('unreachable');
    expect(result.reason).toBe('facilitator-routed');
  });

  test('a failed transaction is rejected before anything else is read', () => {
    const failed = tx(
      [
        { owner: WALLET, mint: USDC_MINT, raw: '-10000000' },
        { owner: PAYEE_A, mint: USDC_MINT, raw: '10000000' },
      ],
      { error: 'InstructionError' },
    );
    const result = classifyUsdcDebit(failed, WALLET);
    expect(result.action).toBe('skip');
    if (result.action !== 'skip') throw new Error('unreachable');
    expect(result.reason).toBe('failed-tx');
  });

  test('an excluded payee (the USDC mint itself) is rejected', () => {
    const result = classifyUsdcDebit(payment(USDC_MINT, 1, 'sig-x'), WALLET);
    expect(result.action).toBe('skip');
    if (result.action !== 'skip') throw new Error('unreachable');
    expect(result.reason).toBe('excluded-payee');
  });

  test('a non-USDC transfer is ignored entirely', () => {
    const result = classifyUsdcDebit(
      tx([
        { owner: WALLET, mint: SOL_MINT, raw: '-120000000', decimals: 9 },
        { owner: PAYEE_A, mint: SOL_MINT, raw: '120000000', decimals: 9 },
      ]),
      WALLET,
    );
    expect(result.action).toBe('skip');
    if (result.action !== 'skip') throw new Error('unreachable');
    expect(result.reason).toBe('no-debit');
  });

  test('direction is read from the deltas, not from whose feed produced the tx', () => {
    // PAYEE_A pays WALLET. The SAME transaction appears in both wallets' feeds,
    // and must yield a row exactly once — attributed to the payer.
    const inbound = tx(
      [
        { owner: PAYEE_A, mint: USDC_MINT, raw: '-3000000' },
        { owner: WALLET, mint: USDC_MINT, raw: '3000000' },
      ],
      { signature: 'sig-in' },
    );

    // Scanning the payer: a real payment.
    const asPayer = classifyUsdcDebit(inbound, PAYEE_A);
    expect(asPayer.action).toBe('row');
    if (asPayer.action !== 'row') throw new Error('unreachable');
    expect(asPayer.counterparty).toBe(WALLET);

    // Scanning the recipient: nothing. This wallet spent nothing here, so it
    // gets no outbound row — which is what keeps `coverage` honest.
    const asPayee = classifyUsdcDebit(inbound, WALLET);
    expect(asPayee.action).toBe('skip');
    if (asPayee.action !== 'skip') throw new Error('unreachable');
    expect(asPayee.reason).toBe('no-debit');
  });

  test('multi-credit records the largest leg and flags it', () => {
    const result = classifyUsdcDebit(
      tx([
        { owner: WALLET, mint: USDC_MINT, raw: '-15000000' },
        { owner: PAYEE_A, mint: USDC_MINT, raw: '5000000' },
        { owner: PAYEE_B, mint: USDC_MINT, raw: '10000000' },
      ]),
      WALLET,
    );
    expect(result.action).toBe('row');
    if (result.action !== 'row') throw new Error('unreachable');
    expect(result.counterparty).toBe(PAYEE_B);
    // The LEG's amount, not the wallet's full 15 USDC debit — attributing the
    // whole batch to one payee would overstate that relationship.
    expect(result.amount).toBeCloseTo(10, 6);
    expect(result.multiCredit).toBe(true);
  });

  test('a payee holding two token accounts is summed, not split', () => {
    const result = classifyUsdcDebit(
      tx([
        { owner: WALLET, mint: USDC_MINT, raw: '-8000000' },
        { owner: PAYEE_A, mint: USDC_MINT, raw: '3000000' },
        { owner: PAYEE_A, mint: USDC_MINT, raw: '5000000' },
      ]),
      WALLET,
    );
    expect(result.action).toBe('row');
    if (result.action !== 'row') throw new Error('unreachable');
    expect(result.counterparty).toBe(PAYEE_A);
    expect(result.amount).toBeCloseTo(8, 6);
    // One payee across two accounts is NOT a multi-leg payout.
    expect(result.multiCredit).toBe(false);
  });
});

// ─── Row mapping ──────────────────────────────────────────────────────────────

describe('toTransactionRow', () => {
  test('maps payer, payee and the USDC mint as facilitator', () => {
    const source = payment(PAYEE_A, 10, 'sig-row');
    const decision = classifyUsdcDebit(source, WALLET);
    if (decision.action !== 'row') throw new Error('expected a row');
    const row = toTransactionRow(decision, WALLET, source);

    expect(row.chain).toBe('solana');
    expect(row.wallet_address).toBe(WALLET);
    expect(row.counterparty).toBe(PAYEE_A);
    // There is no facilitator in this flow. Recording one would relabel a
    // self-submitted payment as routed.
    expect(row.facilitator).toBe(USDC_MINT);
    expect(row.amount).toBeCloseTo(10, 6);
    expect(row.success).toBe(true);
    expect(row.tx_signature).toBe('sig-row');
    expect(row.timestamp).toBe(new Date(1_756_000_000 * 1000).toISOString());
  });

  test('base58 case is preserved byte-for-byte', () => {
    // Lowercasing is EVM-scoped. Applying it here reproduces the 2026-08-17 Arc
    // casing split in reverse, orphaning every row from its wallet.
    const mixed = 'SAT8g2xU7AFy7eUmNJ9SNrM6yYo7LDCi13GXJ8Ez9kC';
    const source = payment(mixed, 1, 'sig-case');
    const decision = classifyUsdcDebit(source, WALLET);
    if (decision.action !== 'row') throw new Error('expected a row');
    const row = toTransactionRow(decision, WALLET, source);
    expect(row.counterparty).toBe(mixed);
    expect(row.wallet_address).toBe(WALLET);
  });
});

// ─── The seed set ─────────────────────────────────────────────────────────────

describe('buildSolanaSeedSet', () => {
  test('seeds payees observed on x402 receipts', () => {
    const seed = buildSolanaSeedSet({
      payeeRows: [{ counterparty: PAYEE_A }, { counterparty: PAYEE_B }],
    });
    expect(seed.has(PAYEE_A)).toBe(true);
    expect(seed.has(PAYEE_B)).toBe(true);
    expect(seed.size).toBe(2);
  });

  test('excludes the USDC mint and every known facilitator', () => {
    const seed = buildSolanaSeedSet({
      payeeRows: [
        { counterparty: USDC_MINT },
        { counterparty: FACILITATOR },
        { counterparty: PAYEE_A },
      ],
    });
    expect(seed.has(USDC_MINT)).toBe(false);
    expect(seed.has(FACILITATOR)).toBe(false);
    expect(seed.has(PAYEE_A)).toBe(true);
    // Both are in the shared exclusion set, not filtered ad hoc at one call site.
    expect(SOLANA_TRANSFER_EXCLUSIONS.has(USDC_MINT)).toBe(true);
    expect(SOLANA_TRANSFER_EXCLUSIONS.has(FACILITATOR)).toBe(true);
  });

  test('drops malformed and empty addresses at the shape gate', () => {
    const seed = buildSolanaSeedSet({
      payeeRows: [
        { counterparty: '' },
        { counterparty: null },
        { counterparty: 'not-base58-0OIl' },
        { counterparty: 'short' },
        { counterparty: PAYEE_A },
      ],
    });
    expect(seed.size).toBe(1);
    expect(seed.has(PAYEE_A)).toBe(true);
  });

  test('THE CLOSURE GUARD: a payee from this indexer’s own row never seeds', () => {
    // A row this job wrote carries `facilitator = USDC_MINT`. If such a row can
    // nominate a provider, run N's payees become run N+1's scan targets and the
    // seed becomes a transitive closure over the Solana USDC payment graph —
    // the Arc firehose through a side door.
    const seed = buildSolanaSeedSet({
      payeeRows: [
        { counterparty: PAYEE_A, facilitator: FACILITATOR },
        { counterparty: PAYEE_B, facilitator: USDC_MINT },
      ],
    });
    expect(seed.has(PAYEE_A)).toBe(true);
    expect(seed.has(PAYEE_B)).toBe(false);
  });

  test('undeclared ROUTERS are excluded from the seed and as payees', () => {
    // Surfaced only once the closure guard was fixed. Neither has EVER been a
    // payer; `Cs2zdfUNon…` takes from 749 addresses and forwards to 19. Walking
    // one would record its payers as customers and its payees as vendors, when
    // it is the intermediary between them — the same reason declared
    // facilitators are excluded.
    for (const router of UNDECLARED_ROUTERS) {
      expect(SOLANA_TRANSFER_EXCLUSIONS.has(router)).toBe(true);
      expect(ALL_FACILITATOR_ADDRESSES).not.toContain(router);

      // Never seeded, even arriving on a legitimate x402 row…
      const seed = buildSolanaSeedSet({
        payeeRows: [{ counterparty: router, facilitator: FACILITATOR }],
      });
      expect(seed.has(router)).toBe(false);

      // …and never recorded as a payee either. The two checks are independent:
      // a SEEDED provider paying a router must not create the relationship.
      const decision = classifyUsdcDebit(payment(router, 5, 'sig-router'), WALLET);
      expect(decision.action).toBe('skip');
      if (decision.action !== 'skip') throw new Error('unreachable');
      expect(decision.reason).toBe('excluded-payee');
    }
  });

  test('the guard EXCLUDES our own rows — it does not allow-list known facilitators', () => {
    // `SOLANA_FACILITATORS` is auto-generated from x402scan, so an allowlist
    // makes scope shrink whenever upstream reshuffles. Measured 2026-09-10: two
    // facilitators present in `transactions` but absent from the config carried
    // 871 of the 1,221 recent payees — 71% of the provider population would
    // have been silently dropped.
    const UNKNOWN_FACILITATOR = 'BcdwLA62UPEAvRn7AWauMUXKtYMXxdLzTPaSQg5tNaFc';
    expect(ALL_FACILITATOR_ADDRESSES).not.toContain(UNKNOWN_FACILITATOR);

    // The PAYEE is what must survive: a row routed through a facilitator the
    // config has never heard of still nominates its payee as a provider.
    const seed = buildSolanaSeedSet({
      payeeRows: [{ counterparty: PAYEE_A, facilitator: UNKNOWN_FACILITATOR }],
    });
    expect(seed.has(PAYEE_A)).toBe(true);
  });
});

// ─── The DI core ──────────────────────────────────────────────────────────────

function makeDeps(over: Partial<SolanaTransfersDeps> = {}): {
  deps: SolanaTransfersDeps;
  rows: Array<{ wallet_address: string; counterparty: string | null }>;
  signals: Array<{ agentWallet: string; face: string }>;
  wallets: string[];
  cursors: Map<string, string>;
  sigCalls: Array<{ address: string; before?: string }>;
} {
  const rows: Array<{ wallet_address: string; counterparty: string | null }> = [];
  const signals: Array<{ agentWallet: string; face: string }> = [];
  const wallets: string[] = [];
  const cursors = new Map<string, string>();
  const sigCalls: Array<{ address: string; before?: string }> = [];

  const deps: SolanaTransfersDeps = {
    seed: new Set([WALLET]),
    scanTargets: [WALLET],
    getSignaturesForAddress: async (address, opts) => {
      sigCalls.push({ address, ...(opts.before ? { before: opts.before } : {}) });
      return opts.before ? [] : [{ signature: 'sig-1', blockTime: 1_756_000_000 }];
    },
    parseTransactionsBatch: async (sigs) => ({
      transactions: sigs.map((s) => payment(PAYEE_A, 10, s)),
      requested: sigs.length,
      unresolved: [],
      undecodable: 0,
      recoveredFromArchive: 0,
    }),
    insertTransactions: async (r) => {
      rows.push(...r.map((x) => ({ wallet_address: x.wallet_address, counterparty: x.counterparty ?? null })));
      return r.length;
    },
    insertSignalEvents: async (s) => {
      signals.push(...s.map((x) => ({ agentWallet: x.agentWallet, face: String(x.face) })));
      return s.length;
    },
    ensureWallets: async (a) => { wallets.push(...a); },
    getCursor: async () => null,
    upsertCursor: async (key, sig) => { cursors.set(key, sig); },
    maxSignatures: 100,
    pageSize: 50,
    ...over,
  };
  return { deps, rows, signals, wallets, cursors, sigCalls };
}

describe('solanaTransfersIndexer', () => {
  test('writes a row and advances the cursor for a seeded provider', async () => {
    const { deps, rows, cursors } = makeDeps();
    const result = await solanaTransfersIndexer(deps);

    expect(result.inserted).toBe(1);
    expect(rows[0].wallet_address).toBe(WALLET);
    expect(rows[0].counterparty).toBe(PAYEE_A);
    expect(cursors.get(solanaTransfersCursorKey(WALLET))).toBe('sig-1');
  });

  test('EMPTY SEED IS A NO-OP: zero RPC calls, no cursor movement', async () => {
    // An empty seed means we know nothing about this population — it must never
    // degrade into an unfiltered scan. Guard runs BEFORE any IO.
    const { deps, sigCalls, cursors, rows } = makeDeps({ seed: new Set(), scanTargets: [] });
    const result = await solanaTransfersIndexer(deps);

    expect(sigCalls).toHaveLength(0);
    expect(cursors.size).toBe(0);
    expect(rows).toHaveLength(0);
    expect(result.inserted).toBe(0);
  });

  test('SEEDED FACE ONLY: wallets and signals cover the payer, never the payee', async () => {
    // Minting the payee into `wallets` puts CEX deposit addresses and DEX
    // vaults into explore_agents (the canonical agent count), and a provider
    // signal for one would make it a Receipt-backed provider. The FK only
    // needs the payer.
    const { deps, wallets, signals } = makeDeps();
    await solanaTransfersIndexer(deps);

    expect(wallets).toEqual([WALLET]);
    expect(wallets).not.toContain(PAYEE_A);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toEqual({ agentWallet: WALLET, face: 'consumer' });
  });

  test('an unresolved signature does NOT advance the cursor past it', async () => {
    // The scan only walks backwards, so a signature skipped now is never
    // revisited. Banking a cursor below it turns an RPC miss into silently
    // lost history.
    const { deps, cursors } = makeDeps({
      getSignaturesForAddress: async (_a, opts) =>
        opts.before ? [] : [
          { signature: 'sig-new', blockTime: 1_756_000_100 },
          { signature: 'sig-missing', blockTime: 1_756_000_050 },
          { signature: 'sig-old', blockTime: 1_756_000_000 },
        ],
      parseTransactionsBatch: async (sigs) => ({
        transactions: sigs.filter((s) => s !== 'sig-missing').map((s) => payment(PAYEE_A, 1, s)),
        requested: sigs.length,
        unresolved: ['sig-missing'],
        undecodable: 0,
        recoveredFromArchive: 0,
      }),
    });
    const result = await solanaTransfersIndexer(deps);

    // The deepest signature we actually resolved is sig-new; sig-missing sits
    // below it, so the cursor may not pass sig-new.
    expect(cursors.get(solanaTransfersCursorKey(WALLET))).toBe('sig-new');
    expect(result.unresolved).toBe(1);
  });

  test('a write failure banks no cursor, so the next run re-reads the page', async () => {
    const { deps, cursors } = makeDeps({
      insertTransactions: async () => { throw new Error('57014'); },
    });
    const result = await solanaTransfersIndexer(deps);

    expect(cursors.size).toBe(0);
    expect(result.failed).toEqual([WALLET]);
  });

  test('a resumed run pages from the persisted cursor', async () => {
    const { deps, sigCalls } = makeDeps({
      getCursor: async () => ({ last_signature: 'sig-banked', last_slot: null }),
    });
    await solanaTransfersIndexer(deps);
    expect(sigCalls[0].before).toBe('sig-banked');
  });

  test('rejected transactions are counted by reason and produce no rows', async () => {
    const { deps, rows } = makeDeps({
      getSignaturesForAddress: async (_a, opts) =>
        opts.before ? [] : [
          { signature: 'sig-a', blockTime: 1_756_000_000 },
          { signature: 'sig-b', blockTime: 1_755_000_000 },
        ],
      parseTransactionsBatch: async () => ({
        transactions: [
          payment(FACILITATOR, 1, 'sig-a'),
          tx([{ owner: WALLET, mint: USDC_MINT, raw: '-1000000' }], { signature: 'sig-b' }),
        ],
        requested: 2,
        unresolved: [],
        undecodable: 0,
        recoveredFromArchive: 0,
      }),
    });
    const result = await solanaTransfersIndexer(deps);

    expect(rows).toHaveLength(0);
    expect(result.skipped['facilitator-routed']).toBe(1);
    expect(result.skipped['no-payee']).toBe(1);
  });

  test('the same transaction seen from two seeded wallets yields one row', async () => {
    // tx_signature is UNIQUE. Emitting the row twice would let the DB swallow
    // one silently while `fetched` overstated what landed.
    const shared = payment(PAYEE_A, 4, 'sig-shared');
    const { deps, rows } = makeDeps({
      seed: new Set([WALLET, PAYEE_B]),
      scanTargets: [WALLET, PAYEE_B],
      getSignaturesForAddress: async (_a, opts) =>
        opts.before ? [] : [{ signature: 'sig-shared', blockTime: 1_756_000_000 }],
      parseTransactionsBatch: async () => ({
        transactions: [shared],
        requested: 1,
        unresolved: [],
        undecodable: 0,
        recoveredFromArchive: 0,
      }),
    });
    await solanaTransfersIndexer(deps);
    expect(rows).toHaveLength(1);
  });
});

// ─── The census fixture ───────────────────────────────────────────────────────

describe('census: J7aN3PLJnT… complete outbound history (mainnet, 2026-09-10)', () => {
  /**
   * Enumerated exhaustively on chain: 12 owner signatures, 0 RPC misses, 6 USDC
   * debits, all six plain payments to distinct non-facilitator payees, two of
   * them carrying a second credit leg. This is ground truth, not a guess — if
   * the decoder disagrees with it, the decoder is wrong.
   */
  const CENSUS: Array<{ sig: string; payee: string; amount: number; multi: boolean }> = [
    { sig: 'census-1', payee: 'A6c5Pt1U4mZjnZxLZjQjFqvBQ8oPzYfXWbNqKcTdRuVe', amount: 10, multi: false },
    { sig: 'census-2', payee: '5Guq7ooZFtHXwPtLZxCkVnVqYyRmBdTsWjNfEaKuPzGh', amount: 5, multi: false },
    { sig: 'census-3', payee: 'CnV9h39kAQpXmYzLwRtFbNjKdSvHgUeQaZcMpTrXwYuB', amount: 25, multi: true },
    { sig: 'census-4', payee: 'JBzVJ7WZPcRmTkYqNdLxWvHfAgUsEoPiXbCnQrZtMyKd', amount: 2, multi: false },
    { sig: 'census-5', payee: 'BJaMfT2jT9WqZxNvLcRkYdHsUpEgAoTiXmBnQrPzWyKf', amount: 3, multi: true },
    { sig: 'census-6', payee: 'BthJwJtt2nQxZvLmRcKyDsHpUgEaToPiXbNnQrPzWyMf', amount: 3, multi: false },
  ];
  const SPARE = 'FJqAJ4dXkFbrp3EEo8E9x98iaBGUQwaU8Srz5ePfUXLH';

  function censusTx(entry: typeof CENSUS[number]): HeliusEnhancedTransaction {
    const raw = Math.round(entry.amount * 1e6);
    const deltas: Delta[] = [
      { owner: WALLET, mint: USDC_MINT, raw: String(-(raw + (entry.multi ? 1_000_000 : 0))) },
      { owner: entry.payee, mint: USDC_MINT, raw: String(raw) },
    ];
    // The second leg is deliberately SMALLER, so "largest leg wins" is what
    // selects the payee the census recorded.
    if (entry.multi) deltas.push({ owner: SPARE, mint: USDC_MINT, raw: '1000000' });
    return tx(deltas, { signature: entry.sig });
  }

  test('decodes exactly 6 payments to 6 distinct payees, flagging 2 as multi-leg', async () => {
    // The 6 payment txs plus 6 unrelated signatures = the real 12-sig feed.
    const noise = Array.from({ length: 6 }, (_, i) =>
      tx([{ owner: WALLET, mint: SOL_MINT, raw: '-5000', decimals: 9 }], { signature: `noise-${i}` }));

    const captured: Array<{ counterparty: string | null; amount: number }> = [];
    const { deps } = makeDeps({
      getSignaturesForAddress: async (_a, opts) =>
        opts.before ? [] : [...CENSUS.map((c) => ({ signature: c.sig, blockTime: 1_756_000_000 })),
          ...noise.map((n) => ({ signature: n.signature, blockTime: 1_755_000_000 }))],
      parseTransactionsBatch: async () => ({
        transactions: [...CENSUS.map(censusTx), ...noise],
        requested: 12,
        unresolved: [],
        undecodable: 0,
        recoveredFromArchive: 0,
      }),
      insertTransactions: async (r) => {
        captured.push(...r.map((x) => ({ counterparty: x.counterparty ?? null, amount: Number(x.amount) })));
        return r.length;
      },
    });

    const result = await solanaTransfersIndexer(deps);

    expect(result.inserted).toBe(6);
    expect(captured).toHaveLength(6);
    expect(new Set(captured.map((c) => c.counterparty)).size).toBe(6);
    expect(captured.map((c) => c.amount).sort((a, b) => a - b)).toEqual([2, 3, 3, 5, 10, 25]);
    expect(result.multiCredit).toBe(2);
    // Coverage 1.0: every row names a payee, so computeReciprocity can answer.
    expect(captured.every((c) => c.counterparty !== null)).toBe(true);
  });
});

// ─── Cross-module invariants ──────────────────────────────────────────────────

describe('production wiring invariants', () => {
  /**
   * THE STALL GUARD. This walk is historical, so the primary RPC (which prunes
   * at ~2 days) misses essentially every signature and the archive serves them
   * all. `parseWithArchiveFallback` retries misses OLDEST-first, capped at
   * ARCHIVE_RETRY_BUDGET — so a page bigger than that budget leaves its NEWEST
   * signatures unresolved. `walkWallet` then blocks at signatures[0], banks no
   * cursor, and the wallet is stuck on the same page forever, reporting zero
   * rows. It would strand exactly the busiest providers.
   *
   * Two modules, each individually correct; the bug lives only in their
   * composition, so no DI test can reach it. Pinned statically instead.
   */
  test('a fully-missed page fits inside the archive retry budget', () => {
    expect(PAGE_SIZE).toBeLessThanOrEqual(ARCHIVE_RETRY_BUDGET);
  });

  test('wallet walks are serial — concurrency measured SLOWER on the archive RPC', () => {
    // 2026-09-10: 1 request at a time ran 0.6 req/s; 2-way dropped to 0.3 as
    // 429 retries multiplied. Raising this is a regression, not a speed-up.
    expect(ADDRESS_CONCURRENCY).toBe(1);
  });
});

describe('walk termination', () => {
  test('pages through several requests until maxSignatures is reached', async () => {
    const pages: Record<string, Array<{ signature: string; blockTime: number }>> = {
      '': [{ signature: 's4', blockTime: 4 }, { signature: 's3', blockTime: 3 }],
      s3: [{ signature: 's2', blockTime: 2 }, { signature: 's1', blockTime: 1 }],
      s1: [],
    };
    const seen: string[] = [];
    const { deps, cursors } = makeDeps({
      pageSize: 2,
      maxSignatures: 4,
      getSignaturesForAddress: async (_a, opts) => pages[opts.before ?? ''] ?? [],
      parseTransactionsBatch: async (sigs) => {
        seen.push(...sigs);
        return {
          transactions: sigs.map((sig) => payment(PAYEE_A, 1, sig)),
          requested: sigs.length, unresolved: [], undecodable: 0, recoveredFromArchive: 0,
        };
      },
    });
    const result = await solanaTransfersIndexer(deps);

    // Both pages walked, cap respected, cursor left at the deepest signature.
    expect(seen).toEqual(['s4', 's3', 's2', 's1']);
    expect(result.inserted).toBe(4);
    expect(cursors.get(solanaTransfersCursorKey(WALLET))).toBe('s1');
  });

  test('the wall-clock budget stops the walk and banks what was already read', async () => {
    let clock = 0;
    const { deps, cursors } = makeDeps({
      pageSize: 2,
      maxSignatures: 100,
      timeBudgetMs: 10,
      // Each page costs 8ms of virtual time, so the second page is over budget.
      now: () => (clock += 8),
      getSignaturesForAddress: async (_a, opts) =>
        opts.before ? [{ signature: 'deep-1', blockTime: 1 }, { signature: 'deep-2', blockTime: 0 }]
          : [{ signature: 'top-1', blockTime: 3 }, { signature: 'top-2', blockTime: 2 }],
      parseTransactionsBatch: async (sigs) => ({
        transactions: sigs.map((sig) => payment(PAYEE_A, 1, sig)),
        requested: sigs.length, unresolved: [], undecodable: 0, recoveredFromArchive: 0,
      }),
    });
    const result = await solanaTransfersIndexer(deps);

    // The first page's work is committed and its cursor banked — a budget stop
    // must not discard reads that already succeeded.
    expect(result.inserted).toBe(2);
    expect(cursors.get(solanaTransfersCursorKey(WALLET))).toBe('top-2');
  });

  test('an UNDECODABLE signature lets the cursor pass — unlike an unresolved one', async () => {
    // Fetched successfully but carrying no `meta`: no token balances exist, so
    // no extractor could ever produce anything. Deterministic, so holding the
    // cursor on it would wedge the wallet forever for no gain. This is the one
    // miss the walk is allowed to step over, and confusing it with `unresolved`
    // would either wedge a wallet or silently lose real history.
    const { deps, cursors, rows } = makeDeps({
      getSignaturesForAddress: async (_a, opts) =>
        opts.before ? [] : [{ signature: 'no-meta', blockTime: 2 }, { signature: 'good', blockTime: 1 }],
      parseTransactionsBatch: async (sigs) => ({
        transactions: [payment(PAYEE_A, 7, 'good')],
        requested: sigs.length,
        unresolved: [],
        undecodable: 1,
        recoveredFromArchive: 0,
      }),
    });
    const result = await solanaTransfersIndexer(deps);

    expect(result.unresolved).toBe(0);
    expect(rows).toHaveLength(1);
    // Stepped over 'no-meta' and banked the deeper signature.
    expect(cursors.get(solanaTransfersCursorKey(WALLET))).toBe('good');
  });

  test('every signature of a page unresolved banks NO cursor at all', async () => {
    // The stall case, at the unit level: nothing above the gap resolved, so
    // there is no safe anchor. Reporting progress here is what would lose
    // history permanently.
    const { deps, cursors, rows } = makeDeps({
      getSignaturesForAddress: async (_a, opts) =>
        opts.before ? [] : [{ signature: 'gap-1', blockTime: 2 }, { signature: 'gap-2', blockTime: 1 }],
      parseTransactionsBatch: async (sigs) => ({
        transactions: [], requested: sigs.length,
        unresolved: [...sigs], undecodable: 0, recoveredFromArchive: 0,
      }),
    });
    const result = await solanaTransfersIndexer(deps);

    expect(cursors.size).toBe(0);
    expect(rows).toHaveLength(0);
    // Reports the whole page as retry-eligible, not just the blocking signature.
    expect(result.unresolved).toBe(2);
  });
});
