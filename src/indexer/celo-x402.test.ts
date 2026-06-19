/// <reference types="bun-types" />
/**
 * Celo x402 settlement indexer tests.
 *
 * Mock strategy: DEPENDENCY INJECTION (mirrors arc-jobs.test.ts /
 * stellar-x402.test.ts). The core accepts injected `getHead` / `getLogs` / DB
 * hooks so tests drive the Celo RPC response deterministically — no live RPC.
 *
 * Run: bun test src/indexer/celo-x402.test.ts
 */

import { describe, expect, test } from 'bun:test';
import {
  toRecord,
  toTransactionRow,
  toSignalPair,
  celoTxSignature,
  celoX402Indexer,
  CELO_CURSOR_KEY,
  CELO_DEFAULT_WINDOW,
  type CeloX402Transfer,
} from './celo-x402';
import { CELO_X402_TOKENS } from '../config/celo-x402';
import type { Transaction } from '../db/schema';

// ── Fixtures ──────────────────────────────────────────────────────────────────
const FACIL = '0xfaceface00000000000000000000000000000001' as const;
const PAYER = '0x1111111111111111111111111111111111111111' as const;
const PAYEE = '0x2222222222222222222222222222222222222222' as const;
const USDC = CELO_X402_TOKENS[0]; // 6-dec
const FACIL_SET: ReadonlySet<string> = new Set([FACIL.toLowerCase()]);

function transfer(opts: {
  from?: `0x${string}`;
  to?: `0x${string}`;
  facilitator?: `0x${string}`;
  direction?: 'incoming' | 'outgoing';
  rawValue?: bigint;
  block?: bigint;
  logIndex?: number;
  txHash?: `0x${string}`;
}): CeloX402Transfer {
  const rawValue = opts.rawValue ?? BigInt(1_500_000); // 1.5 USDC (6-dec)
  return {
    txHash: opts.txHash ?? '0xtransfer',
    blockNumber: opts.block ?? BigInt(120),
    logIndex: opts.logIndex ?? 0,
    token: USDC,
    from: opts.from ?? PAYER,
    to: opts.to ?? FACIL,
    rawValue,
    value: Number(rawValue) / 10 ** USDC.decimals,
    direction: opts.direction ?? 'incoming',
    facilitator: opts.facilitator ?? FACIL,
  };
}

function makeDeps(
  transfers: CeloX402Transfer[],
  overrides: Partial<Parameters<typeof celoX402Indexer>[0]> = {},
) {
  const inserted: Array<Omit<Transaction, 'id'>> = [];
  const signals: unknown[] = [];
  const ensured: string[] = [];
  const cursors: Array<[string, string, number | undefined]> = [];
  let getLogsCalls = 0;
  let getHeadCalls = 0;
  const windows: Array<[bigint, bigint]> = [];

  const deps = {
    facilitators: FACIL_SET,
    getHead: async () => { getHeadCalls++; return BigInt(120); },
    getLogs: async (from: bigint, to: bigint) => {
      getLogsCalls++;
      windows.push([from, to]);
      return transfers;
    },
    blockTimestamp: async () => '2026-06-17T00:00:00.000Z',
    insertTransactions: async (rows: Omit<Transaction, 'id'>[]) => { inserted.push(...rows); return rows.length; },
    insertSignalEvents: async (s: unknown[]) => { signals.push(...s); return s.length; },
    ensureWallet: async (a: string) => { ensured.push(a); },
    getCursor: async () => null,
    upsertCursor: async (key: string, last: string, slot?: number) => { cursors.push([key, last, slot]); },
    startBlockFallback: BigInt(0),
    ...overrides,
  };

  return {
    deps,
    state: {
      inserted, signals, ensured, cursors, windows,
      get getLogsCalls() { return getLogsCalls; },
      get getHeadCalls() { return getHeadCalls; },
    },
  };
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('toRecord — facilitator from/to match', () => {
  function log(from: string, to: string, value: bigint, extra: Partial<{ blockNumber: bigint; transactionHash: string; logIndex: number }> = {}) {
    return {
      args: { from, to, value },
      blockNumber: extra.blockNumber ?? BigInt(100),
      transactionHash: extra.transactionHash ?? '0xabc',
      logIndex: extra.logIndex ?? 3,
    } as unknown as Parameters<typeof toRecord>[0];
  }

  test('matches facilitator as receiver → direction incoming', () => {
    const rec = toRecord(log(PAYER, FACIL, BigInt(2_000_000)), USDC, FACIL_SET);
    expect(rec).not.toBeNull();
    expect(rec!.direction).toBe('incoming');
    expect(rec!.facilitator.toLowerCase()).toBe(FACIL.toLowerCase());
    expect(rec!.from).toBe(PAYER);
    expect(rec!.to).toBe(FACIL);
    expect(rec!.value).toBeCloseTo(2.0, 9); // 6-dec decode
  });

  test('matches facilitator as sender → direction outgoing', () => {
    const rec = toRecord(log(FACIL, PAYEE, BigInt(1_000_000)), USDC, FACIL_SET);
    expect(rec!.direction).toBe('outgoing');
    expect(rec!.facilitator.toLowerCase()).toBe(FACIL.toLowerCase());
  });

  test('returns null when no watched facilitator is from/to', () => {
    expect(toRecord(log(PAYER, PAYEE, BigInt(1_000_000)), USDC, FACIL_SET)).toBeNull();
  });

  test('returns null on malformed log (missing value)', () => {
    const bad = { args: { from: PAYER, to: FACIL }, blockNumber: BigInt(1), transactionHash: '0x', logIndex: 0 } as unknown as Parameters<typeof toRecord>[0];
    expect(toRecord(bad, USDC, FACIL_SET)).toBeNull();
  });
});

describe('toTransactionRow / toSignalPair', () => {
  test('row: chain=celo, wallet=payer(from), facilitator=matched, tx_signature=txHash:logIndex', () => {
    const t = transfer({ rawValue: BigInt(3_000_000), txHash: '0xfeed', logIndex: 5 });
    const row = toTransactionRow(t, '2026-06-17T00:00:00.000Z');
    expect(row.chain).toBe('celo');
    expect(row.wallet_address).toBe(PAYER);
    expect(row.facilitator).toBe(FACIL);
    expect(row.amount).toBeCloseTo(3.0, 9);
    expect(row.success).toBe(true);
    expect(row.tx_signature).toBe('0xfeed:5'); // batch-safe per-event key
  });

  test('signal pair: consumer(payer)+provider(payee), chain=celo, txRef=tx_signature', () => {
    const t = transfer({ txHash: '0xfeed', logIndex: 2 });
    const pair = toSignalPair(t, '2026-06-17T00:00:00.000Z');
    expect(pair.length).toBe(2);
    const consumer = pair.find((s) => s.face === 'consumer')!;
    const provider = pair.find((s) => s.face === 'provider')!;
    expect(consumer.agentWallet).toBe(PAYER); // payer = from
    expect(provider.agentWallet).toBe(FACIL); // payee = to
    expect(consumer.chain).toBe('celo');
    expect(provider.chain).toBe('celo');
    expect(consumer.tier).toBe(1);
    expect(consumer.kind).toBe('paysh_routed');
    expect(consumer.txRef).toBe('0xfeed:2');
    expect(provider.txRef).toBe(celoTxSignature(t));
  });
});

// ── DI core ─────────────────────────────────────────────────────────────────

describe('celoX402Indexer — DI core', () => {
  test('one matched transfer → 1 tx row + 2 dual-face signals + both wallets ensured', async () => {
    const { deps, state } = makeDeps([transfer({ rawValue: BigInt(2_500_000), txHash: '0xs1' })]);
    const res = await celoX402Indexer(deps);

    expect(res.fetched).toBe(1);
    expect(res.inserted).toBe(1);
    expect(state.inserted[0].chain).toBe('celo');
    expect(state.inserted[0].wallet_address).toBe(PAYER);
    expect(state.inserted[0].amount).toBeCloseTo(2.5, 9);
    expect(state.inserted[0].tx_signature).toBe('0xs1:0');
    expect(state.signals.length).toBe(2);
    expect(state.ensured).toContain(PAYER);
    expect(state.ensured).toContain(FACIL);
  });

  test('empty facilitator set → no-op, no RPC (getHead/getLogs never called), no cursor', async () => {
    const { deps, state } = makeDeps([transfer({})], { facilitators: new Set<string>() });
    const res = await celoX402Indexer(deps);

    expect(res.fetched).toBe(0);
    expect(res.inserted).toBe(0);
    expect(state.getHeadCalls).toBe(0);
    expect(state.getLogsCalls).toBe(0);
    expect(state.cursors.length).toBe(0);
  });

  test('idempotency — batch: 2 transfers in one tx (distinct logIndex) → 2 rows, no UNIQUE collision', async () => {
    const window = [
      transfer({ txHash: '0xbatch', logIndex: 0, rawValue: BigInt(1_000_000) }),
      transfer({ txHash: '0xbatch', logIndex: 1, rawValue: BigInt(2_000_000) }),
    ];
    // Model the transactions.tx_signature UNIQUE constraint (ON CONFLICT DO NOTHING).
    const persisted = new Map<string, Omit<Transaction, 'id'>>();
    const { deps } = makeDeps(window, {
      insertTransactions: async (rows: Omit<Transaction, 'id'>[]) => {
        let n = 0;
        for (const r of rows) if (!persisted.has(r.tx_signature)) { persisted.set(r.tx_signature, r); n++; }
        return n;
      },
    });
    const res = await celoX402Indexer(deps);

    expect(res.fetched).toBe(2);
    expect(res.inserted).toBe(2);
    expect([...persisted.keys()].sort()).toEqual(['0xbatch:0', '0xbatch:1']);
  });

  test('dedup: same transfer returned twice (from/to query overlap) → 1 row', async () => {
    const t = transfer({ txHash: '0xdup', logIndex: 0 });
    const { deps, state } = makeDeps([t, t]); // facilitator paid facilitator → both queries return it
    const res = await celoX402Indexer(deps);

    expect(res.fetched).toBe(1);
    expect(state.inserted.length).toBe(1);
    expect(state.signals.length).toBe(2); // one pair, not two
  });

  test('cursor advances to head under the celo:x402 key', async () => {
    const { deps, state } = makeDeps([transfer({})]);
    const res = await celoX402Indexer(deps);

    expect(state.cursors.length).toBe(1);
    expect(state.cursors[0][0]).toBe(CELO_CURSOR_KEY);
    expect(state.cursors[0][1]).toBe('120');
    expect(state.cursors[0][2]).toBe(120);
    expect(res.cursors.get(CELO_CURSOR_KEY)).toBe('120');
  });

  test('paginates in <=windowSize windows across a multi-window range', async () => {
    const { deps, state } = makeDeps([], {
      getHead: async () => BigInt(2 * CELO_DEFAULT_WINDOW + 10),
      startBlockFallback: BigInt(0),
    });
    await celoX402Indexer(deps);

    expect(state.getLogsCalls).toBe(3); // [0,W-1] [W,2W-1] [2W,2W+10]
    expect(state.windows[0]).toEqual([BigInt(0), BigInt(CELO_DEFAULT_WINDOW - 1)]);
    expect(state.cursors[0][1]).toBe(String(2 * CELO_DEFAULT_WINDOW + 10));
  });

  test('maxWindows caps a run; cursor advances to last processed window', async () => {
    const { deps, state } = makeDeps([], {
      getHead: async () => BigInt(10 * CELO_DEFAULT_WINDOW),
      maxWindows: 2,
      startBlockFallback: BigInt(0),
    });
    await celoX402Indexer(deps);

    expect(state.getLogsCalls).toBe(2);
    expect(state.cursors[0][1]).toBe(String(2 * CELO_DEFAULT_WINDOW - 1));
  });

  test('startBlock = cursor.last_slot + 1 when a cursor exists', async () => {
    const { deps, state } = makeDeps([], {
      getHead: async () => BigInt(5_000),
      getCursor: async () => ({ last_signature: '4200', last_slot: 4200 }),
    });
    await celoX402Indexer(deps);
    expect(state.windows[0][0]).toBe(BigInt(4201));
  });

  test('startBlockFallback used when no cursor exists', async () => {
    const { deps, state } = makeDeps([], {
      getHead: async () => BigInt(9_000),
      startBlockFallback: BigInt(8_500),
    });
    await celoX402Indexer(deps);
    expect(state.windows[0][0]).toBe(BigInt(8_500));
  });

  test('dry window (no transfers) → fetched 0, cursor still advances', async () => {
    const { deps, state } = makeDeps([]);
    const res = await celoX402Indexer(deps);

    expect(res.fetched).toBe(0);
    expect(state.inserted.length).toBe(0);
    expect(state.signals.length).toBe(0);
    expect(state.cursors[0][1]).toBe('120'); // advanced past the scanned window
  });

  test('cursor already at/after head → no getLogs call, returns fetched:0', async () => {
    const { deps, state } = makeDeps([transfer({})], {
      getHead: async () => BigInt(100),
      getCursor: async () => ({ last_signature: '120', last_slot: 120 }), // start = 121 > head
    });
    const res = await celoX402Indexer(deps);

    expect(res.fetched).toBe(0);
    expect(state.getLogsCalls).toBe(0);
    expect(res.cursors.get(CELO_CURSOR_KEY)).toBe('100');
  });
});
