/// <reference types="bun-types" />
/**
 * Arc ERC-8183 job-settlement indexer tests.
 *
 * Mock strategy: DEPENDENCY INJECTION (mirrors stellar-x402.test.ts). The
 * indexer core accepts injected `getHead` / `getLogs` / DB hooks so tests drive
 * the Arc RPC response deterministically without a live RPC endpoint.
 *
 * UNMATCHED-RELEASE POLICY under test: a PaymentReleased with no JobCreated in
 * the window AND no `resolveJobClient` is SKIPPED (no consumer face possible →
 * a provider-only receipt would violate the dual-face settlement model). The
 * cursor still advances past it so it is never re-scanned.
 *
 * Run: bun test src/indexer/arc-jobs.test.ts
 */

import { describe, expect, test } from 'bun:test';
import {
  parseJobCreated,
  parsePaymentReleased,
  toTransactionRow,
  arcJobsIndexer,
  arcJobsCursorKey,
  ARC_JOBS_CONTRACT,
  ARC_MAX_LOG_WINDOW,
  GENESIS_FALLBACK_BLOCK,
  JOB_CREATED_EVENT,
  type ArcJobCreated,
  type ArcPaymentReleased,
  type GetLogsWindow,
  type PAYMENT_RELEASED_EVENT,
} from './arc-jobs';
import type { Transaction } from '../db/schema';
import type { Log } from 'viem';
import { toEventSelector } from 'viem';

// ── Fixture addresses (EVM 0x, 40 hex chars) ──────────────────────────────────
const CLIENT = '0x1111111111111111111111111111111111111111' as const;
const PROVIDER = '0x2222222222222222222222222222222222222222' as const;
const EVALUATOR = '0x3333333333333333333333333333333333333333' as const;
const CLIENT_B = '0x4444444444444444444444444444444444444444' as const;
const PROVIDER_B = '0x5555555555555555555555555555555555555555' as const;
const TS = '2026-06-09T00:00:00.000Z';

// ── Fixture factories for decoded records (what the injected getLogs yields) ──
function created(opts: {
  jobId: bigint; client?: `0x${string}`; provider?: `0x${string}`;
  block?: bigint; txHash?: `0x${string}`;
}): ArcJobCreated {
  return {
    jobId: opts.jobId,
    client: opts.client ?? CLIENT,
    provider: opts.provider ?? PROVIDER,
    evaluator: EVALUATOR,
    expiredAt: BigInt(0),
    blockNumber: opts.block ?? BigInt(100),
    txHash: opts.txHash ?? '0xcreate',
  };
}

function released(opts: {
  jobId: bigint; provider?: `0x${string}`; rawAmount: bigint;
  block?: bigint; txHash?: `0x${string}`;
}): ArcPaymentReleased {
  return {
    jobId: opts.jobId,
    provider: opts.provider ?? PROVIDER,
    rawAmount: opts.rawAmount,
    amount: Number(opts.rawAmount) / 1e6,
    blockNumber: opts.block ?? BigInt(120),
    txHash: opts.txHash ?? '0xsettle',
  };
}

// Default deps: single window covering [start, head], deterministic block ts.
function makeDeps(
  window: GetLogsWindow,
  overrides: Partial<Parameters<typeof arcJobsIndexer>[0]> = {},
) {
  const inserted: Array<Omit<Transaction, 'id'>> = [];
  const signals: unknown[] = [];
  const ensured: string[] = [];
  const cursors: Array<[string, string, number | undefined]> = [];
  let getLogsCalls = 0;
  const windows: Array<[bigint, bigint]> = [];

  const deps = {
    jobsContract: ARC_JOBS_CONTRACT,
    getHead: async () => BigInt(120),
    getLogs: async (from: bigint, to: bigint) => {
      getLogsCalls++;
      windows.push([from, to]);
      return window;
    },
    blockTimestamp: async () => TS,
    insertTransactions: async (rows: Omit<Transaction, 'id'>[]) => { inserted.push(...rows); return rows.length; },
    insertSignalEvents: async (s: unknown[]) => { signals.push(...s); return s.length; },
    ensureWallet: async (a: string) => { ensured.push(a); },
    getCursor: async () => null,
    upsertCursor: async (key: string, last: string, slot?: number) => { cursors.push([key, last, slot]); },
    ...overrides,
  };

  return { deps, state: { inserted, signals, ensured, cursors, get getLogsCalls() { return getLogsCalls; }, windows } };
}

describe('parseJobCreated / parsePaymentReleased', () => {
  test('parseJobCreated decodes jobId/client/provider/evaluator', () => {
    const log = {
      args: { jobId: BigInt(7), client: CLIENT, provider: PROVIDER, evaluator: EVALUATOR, expiredAt: BigInt(999) },
      blockNumber: BigInt(50),
      transactionHash: '0xabc',
    } as unknown as Log<bigint, number, false, typeof JOB_CREATED_EVENT>;
    const rec = parseJobCreated(log);
    expect(rec).not.toBeNull();
    expect(rec!.jobId).toBe(BigInt(7));
    expect(rec!.client).toBe(CLIENT);
    expect(rec!.provider).toBe(PROVIDER);
    expect(rec!.evaluator).toBe(EVALUATOR);
  });

  test('parseJobCreated returns null on missing client', () => {
    const log = {
      args: { jobId: BigInt(7), provider: PROVIDER },
      blockNumber: BigInt(50), transactionHash: '0xabc',
    } as unknown as Log<bigint, number, false, typeof JOB_CREATED_EVENT>;
    expect(parseJobCreated(log)).toBeNull();
  });

  test('parsePaymentReleased decodes 6-dec USDC amount', () => {
    const log = {
      args: { jobId: BigInt(7), provider: PROVIDER, amount: BigInt(1_500_000) }, // 1.5 USDC
      blockNumber: BigInt(60), transactionHash: '0xdef',
    } as unknown as Log<bigint, number, false, typeof PAYMENT_RELEASED_EVENT>;
    const rec = parsePaymentReleased(log);
    expect(rec).not.toBeNull();
    expect(rec!.rawAmount).toBe(BigInt(1_500_000));
    expect(rec!.amount).toBeCloseTo(1.5, 9); // NOT 18-dec: 1.5e6 / 1e6
    expect(rec!.txHash).toBe('0xdef');
  });

  test('parsePaymentReleased applies 6-dec scaling on a sub-cent amount', () => {
    const log = {
      args: { jobId: BigInt(1), provider: PROVIDER, amount: BigInt(1000) }, // 0.001 USDC
      blockNumber: BigInt(60), transactionHash: '0xd',
    } as unknown as Log<bigint, number, false, typeof PAYMENT_RELEASED_EVENT>;
    expect(parsePaymentReleased(log)!.amount).toBeCloseTo(0.001, 9);
  });

  test('parsePaymentReleased returns null on missing amount', () => {
    const log = {
      args: { jobId: BigInt(1), provider: PROVIDER },
      blockNumber: BigInt(60), transactionHash: '0xd',
    } as unknown as Log<bigint, number, false, typeof PAYMENT_RELEASED_EVENT>;
    expect(parsePaymentReleased(log)).toBeNull();
  });
});

describe('event ABI matches the deployed ERC-8183 contract, not the EIP-8183 draft text', () => {
  test('JOB_CREATED_EVENT topic0 is the verified 6-param signature (trailing `hook`)', () => {
    // Deployed AgenticCommerce implementation (0xA316fd02827242D537F84730F8a37D0BA5fd351a,
    // verified via testnet.arcscan.app) emits a trailing `hook` address that the
    // EIP-8183 draft text omits. A silent revert to the 5-param draft signature
    // changes this hash and reintroduces the original bug: getLogs's event filter
    // matches ZERO real JobCreated logs, so every PaymentReleased is unmatched
    // and silently skipped (see the UNMATCHED-RELEASE POLICY tests below).
    expect(toEventSelector(JOB_CREATED_EVENT)).toBe(
      '0xb0f0239bfdd96453e24733e18bfc24b70d8fadf123dd977473518dd577ee79b9',
    );
    // The 5-param draft signature (what shipped originally) hashes differently —
    // pinned here so a future reader can see exactly what NOT to revert to.
    expect(toEventSelector(JOB_CREATED_EVENT)).not.toBe(
      '0xef137df1d007645178f3f70e5c306d8d0b84bb5c70cabda9bb0f8f3c71932a0f',
    );
  });
});

describe('toTransactionRow', () => {
  test('maps a settled job to a chain=arc row (client=payer, escrow=facilitator)', () => {
    const row = toTransactionRow(released({ jobId: BigInt(9), rawAmount: BigInt(2_000_000), txHash: '0xfeed' }), CLIENT, TS);
    // 'arc' is not yet in the schema Chain union (sibling schema pass adds it);
    // compare as a plain string so the assertion is independent of that edit.
    expect(row.chain as string).toBe('arc');
    expect(row.wallet_address).toBe(CLIENT); // consumer/payer face
    expect(row.facilitator).toBe(ARC_JOBS_CONTRACT);
    expect(row.amount).toBeCloseTo(2.0, 9);
    expect(row.timestamp).toBe(TS);
    expect(row.success).toBe(true);
    expect(row.tx_signature).toBe('9:0xfeed'); // `${jobId}:${txHash}` — batch-safe unique key
  });

  test('counterparty = the settlement provider (payee), distinct from the escrow facilitator', () => {
    const PAYEE = '0x000000000000000000000000000000000000beef' as const;
    const row = toTransactionRow(
      released({ jobId: BigInt(9), rawAmount: BigInt(2_000_000), txHash: '0xfeed', provider: PAYEE }),
      CLIENT,
      TS,
    );
    // The scored wallet is the client (payer/consumer face). Its true counterparty
    // is the provider who got paid — NOT the ERC-8183 escrow (the matched router).
    // Mirrors buildJobSettledSignal's `counterparty: provider` for the consumer face.
    expect(row.counterparty).toBe(PAYEE);
    expect(row.facilitator).toBe(ARC_JOBS_CONTRACT);
    expect(row.counterparty).not.toBe(row.facilitator);
  });
});

describe('arcJobsIndexer — DI core', () => {
  test('JobCreated + PaymentReleased pair → 1 tx row + 2 dual-face signals', async () => {
    const window: GetLogsWindow = {
      created: [created({ jobId: BigInt(42) })],
      released: [released({ jobId: BigInt(42), rawAmount: BigInt(2_500_000), txHash: '0xsettle42' })],
    };
    const { deps, state } = makeDeps(window);
    const res = await arcJobsIndexer(deps);

    expect(res.fetched).toBe(1);
    expect(res.inserted).toBe(1);
    expect(state.inserted.length).toBe(1);
    expect(state.inserted[0].chain as string).toBe('arc');
    expect(state.inserted[0].wallet_address).toBe(CLIENT);
    expect(state.inserted[0].facilitator).toBe(ARC_JOBS_CONTRACT);
    expect(state.inserted[0].amount).toBeCloseTo(2.5, 9); // 6-dec decode, not 18
    expect(state.inserted[0].tx_signature).toBe('42:0xsettle42'); // `${jobId}:${txHash}`

    // provider + consumer Tier-1 signals
    expect(state.signals.length).toBe(2);
    const provider = state.signals.find((s) => (s as { face: string }).face === 'provider') as Record<string, unknown>;
    const consumer = state.signals.find((s) => (s as { face: string }).face === 'consumer') as Record<string, unknown>;
    expect(provider).toBeDefined();
    expect(consumer).toBeDefined();
    expect(provider.tier).toBe(1);
    expect(provider.kind).toBe('erc8183_job_settled');
    expect(provider.agentWallet).toBe(PROVIDER);
    expect(consumer.agentWallet).toBe(CLIENT);
    // dedup tx_ref shape = '<jobId>:<txHash>'
    expect(provider.txRef).toBe('42:0xsettle42');
    expect(consumer.txRef).toBe('42:0xsettle42');

    // both faces' wallets ensured for the FK
    expect(state.ensured).toContain(CLIENT);
    expect(state.ensured).toContain(PROVIDER);
  });

  test('templated counterparty is flagged in payload but still recorded (unlike self-dealing, not skipped)', async () => {
    const window: GetLogsWindow = {
      created: [created({ jobId: BigInt(50), client: CLIENT, provider: PROVIDER })],
      released: [released({ jobId: BigInt(50), rawAmount: BigInt(1_000_000), txHash: '0xtemplated' })],
    };
    const { deps, state } = makeDeps(window, {
      // CLIENT presents a templated (bulk-mint farm) identity; PROVIDER does not.
      isTemplatedCounterparty: async (address) => address === CLIENT,
    });
    const res = await arcJobsIndexer(deps);

    expect(res.fetched).toBe(1); // still recorded — not skipped like self-dealing
    const provider = state.signals.find((s) => (s as { face: string }).face === 'provider') as Record<string, unknown>;
    const consumer = state.signals.find((s) => (s as { face: string }).face === 'consumer') as Record<string, unknown>;
    // provider's counterparty is CLIENT (templated) → flagged
    expect((provider.payload as Record<string, unknown>).templatedCounterparty).toBe(true);
    // consumer's counterparty is PROVIDER (not templated) → not flagged
    expect((consumer.payload as Record<string, unknown>).templatedCounterparty).toBe(false);
  });

  test('no isTemplatedCounterparty hook injected → defaults to not flagged (back-compat)', async () => {
    const window: GetLogsWindow = {
      created: [created({ jobId: BigInt(51) })],
      released: [released({ jobId: BigInt(51), rawAmount: BigInt(1_000_000), txHash: '0xnohook' })],
    };
    const { deps, state } = makeDeps(window); // no isTemplatedCounterparty
    await arcJobsIndexer(deps);
    const provider = state.signals.find((s) => (s as { face: string }).face === 'provider') as Record<string, unknown>;
    expect((provider.payload as Record<string, unknown>).templatedCounterparty).toBe(false);
  });

  test('batch settlement: 2 PaymentReleased in one tx → 2 distinct receipt rows (no UNIQUE collision)', async () => {
    const window: GetLogsWindow = {
      created: [
        created({ jobId: BigInt(1), txHash: '0xc1' }),
        created({ jobId: BigInt(2), txHash: '0xc2' }),
      ],
      released: [
        released({ jobId: BigInt(1), rawAmount: BigInt(1_000_000), txHash: '0xbatch' }),
        released({ jobId: BigInt(2), rawAmount: BigInt(2_000_000), txHash: '0xbatch' }),
      ],
    };
    // Model the transactions.tx_signature UNIQUE constraint (Postgres ON CONFLICT
    // DO NOTHING): a bare-txHash key would collapse both rows to one.
    const persisted = new Map<string, Omit<Transaction, 'id'>>();
    const { deps } = makeDeps(window, {
      insertTransactions: async (rows: Omit<Transaction, 'id'>[]) => {
        let n = 0;
        for (const r of rows) if (!persisted.has(r.tx_signature)) { persisted.set(r.tx_signature, r); n++; }
        return n;
      },
    });
    const res = await arcJobsIndexer(deps);

    expect(res.fetched).toBe(2);
    expect(res.inserted).toBe(2);          // both survive — jobId disambiguates the shared txHash
    expect(persisted.size).toBe(2);
    expect([...persisted.keys()].sort()).toEqual(['1:0xbatch', '2:0xbatch']);
  });

  test('cursor advances to head with key namespaced by jobs contract', async () => {
    const window: GetLogsWindow = {
      created: [created({ jobId: BigInt(1) })],
      released: [released({ jobId: BigInt(1), rawAmount: BigInt(1_000_000) })],
    };
    const { deps, state } = makeDeps(window);
    const res = await arcJobsIndexer(deps);

    const key = arcJobsCursorKey(ARC_JOBS_CONTRACT);
    expect(state.cursors.length).toBe(1);
    expect(state.cursors[0][0]).toBe(key);
    expect(state.cursors[0][1]).toBe('120'); // head
    expect(state.cursors[0][2]).toBe(120);
    expect(res.cursors.get(key)).toBe('120');
  });

  test('paginates in <=10k windows across a multi-window range', async () => {
    // head = 25000, start = 0 → expect 3 windows: [0,9999] [10000,19999] [20000,25000]
    const window: GetLogsWindow = { created: [], released: [] };
    const { deps, state } = makeDeps(window, { getHead: async () => BigInt(25_000) });
    await arcJobsIndexer(deps);

    expect(state.getLogsCalls).toBe(3);
    expect(state.windows[0]).toEqual([BigInt(0), BigInt(ARC_MAX_LOG_WINDOW - 1)]);          // [0, 9999]
    expect(state.windows[1]).toEqual([BigInt(10_000), BigInt(19_999)]);
    expect(state.windows[2]).toEqual([BigInt(20_000), BigInt(25_000)]);                      // clamped to head
    // cursor ends at head, not at a 10k boundary
    expect(state.cursors[0][1]).toBe('25000');
  });

  test('maxWindows caps a run: stops early, cursor advances to last processed window', async () => {
    // head = 50000, start = 0, maxWindows = 2 → process [0,9999] [10000,19999] then stop.
    const window: GetLogsWindow = { created: [], released: [] };
    const { deps, state } = makeDeps(window, { getHead: async () => BigInt(50_000), maxWindows: 2 });
    await arcJobsIndexer(deps);

    expect(state.getLogsCalls).toBe(2);
    expect(state.windows[1]).toEqual([BigInt(10_000), BigInt(19_999)]);
    // cursor advances to the last processed `to` (19999), NOT head — next run resumes at 20000.
    expect(state.cursors[0][1]).toBe('19999');
  });

  // Arc's public RPC hands out a small getLogs QUOTA, not a per-second rate:
  // measured 2026-08-10, it serves ~4 windows and then refuses everything for a
  // long while, so neither pacing nor backoff gets a run through. Letting that
  // throw out of the loop discarded EVERY window the run had already read —
  // keep-fresh burned 6 minutes on Arc each cycle and the cursor stayed put, so
  // Arc ingest recorded nothing between 2026-07-16 and 2026-08-10. Absorb the
  // throttle, keep what was read, resume next run.
  test('a mid-run throttle keeps the windows already read and stops cleanly', async () => {
    const window: GetLogsWindow = { created: [], released: [] };
    let calls = 0;
    const { deps, state } = makeDeps(window, {
      getHead: async () => BigInt(50_000),
      getLogs: async (from: bigint, to: bigint) => {
        calls++;
        if (calls > 2) throw Object.assign(new Error('Request exceeds defined limit.'), { code: -32005 });
        state.windows.push([from, to]);
        return window;
      },
    });

    await arcJobsIndexer(deps); // must NOT reject

    // Two windows were read ([0,9999] and [10000,19999]); the third throttled.
    // The cursor must land on the last window actually READ, never on the one we
    // failed to read — advancing past it would silently drop those blocks.
    expect(state.cursors[0][1]).toBe('19999');
  });

  test('a throttle on the very first window advances no cursor at all', async () => {
    const window: GetLogsWindow = { created: [], released: [] };
    const { deps, state } = makeDeps(window, {
      getHead: async () => BigInt(50_000),
      getCursor: async () => ({ last_signature: '4200', last_slot: 4200 }),
      getLogs: async () => { throw Object.assign(new Error('throttled'), { code: -32005 }); },
    });

    await arcJobsIndexer(deps);

    // Nothing was read, so the cursor must stay where it was — writing 4200 back
    // is harmless, but anything beyond it would skip unread blocks.
    for (const [, last] of state.cursors) expect(Number(last)).toBeLessThanOrEqual(4200);
  });

  // Window COUNT is a poor proxy for the work a window costs: a single one can
  // hold hundreds of settlements, each needing a block-timestamp round trip.
  // On 2026-08-10 the pair of Arc indexers ran past 20 minutes inside a job
  // whose steady state was ~2 minutes, so the loop also answers to a clock.
  test('timeBudgetMs stops the loop and banks the windows already read', async () => {
    const window: GetLogsWindow = { created: [], released: [] };
    let clock = 1_000;
    const { deps, state } = makeDeps(window, {
      getHead: async () => BigInt(50_000),
      timeBudgetMs: 5_000,
      // Each window "costs" 2s; the budget allows two, then expires.
      now: () => { clock += 2_000; return clock; },
    });

    await arcJobsIndexer(deps);

    expect(state.getLogsCalls).toBe(2);
    // Cursor lands on the last window READ, so the next run resumes at 20000.
    expect(state.cursors[0][1]).toBe('19999');
  });

  test('no timeBudgetMs means unbounded — the clock never ends a run', async () => {
    const window: GetLogsWindow = { created: [], released: [] };
    const { deps, state } = makeDeps(window, {
      getHead: async () => BigInt(30_000),
      now: () => Number.MAX_SAFE_INTEGER,
    });

    await arcJobsIndexer(deps);

    expect(state.getLogsCalls).toBe(4); // [0,9999] [10000,19999] [20000,29999] [30000,30000]
  });

  test('a non-throttle error still fails the run loudly', async () => {
    const window: GetLogsWindow = { created: [], released: [] };
    const { deps } = makeDeps(window, {
      getHead: async () => BigInt(50_000),
      getLogs: async () => { throw new Error('malformed ABI'); },
    });

    await expect(arcJobsIndexer(deps)).rejects.toThrow('malformed ABI');
  });

  test('startBlock = cursor.last_slot + 1 when a cursor exists', async () => {
    const window: GetLogsWindow = { created: [], released: [] };
    const { deps, state } = makeDeps(window, {
      getHead: async () => BigInt(5_000),
      getCursor: async () => ({ last_signature: '4200', last_slot: 4200 }),
    });
    await arcJobsIndexer(deps);
    // first window starts exactly at last_slot + 1
    expect(state.windows[0][0]).toBe(BigInt(4201));
  });

  test('PaymentReleased with no matching JobCreated + no resolver → SKIPPED, cursor still advances', async () => {
    const window: GetLogsWindow = {
      created: [], // jobId 99's JobCreated landed in an earlier (already-indexed) window
      released: [released({ jobId: BigInt(99), rawAmount: BigInt(7_000_000), txHash: '0xorphan' })],
    };
    const { deps, state } = makeDeps(window); // no resolveJobClient injected
    const res = await arcJobsIndexer(deps);

    expect(res.fetched).toBe(0);          // skipped — cannot attribute consumer face
    expect(res.inserted).toBe(0);
    expect(state.inserted.length).toBe(0);
    expect(state.signals.length).toBe(0);
    expect(state.ensured.length).toBe(0);
    // cursor STILL advances past the scanned block so the orphan is never re-examined
    expect(state.cursors.length).toBe(1);
    expect(state.cursors[0][1]).toBe('120');
  });

  test('self-dealt job (client === provider) is skipped — never emitted as a receipt', async () => {
    // Real-world case: Arc Testnet jobId 155689, a disclosed AK test settlement
    // where the validator wallet played client, provider, AND evaluator
    // (tx 0xdd0cfb80.../0xf5d69b79...). A self-funded, self-paid job proves
    // nothing about independent delivery and must never read as a Tier-1
    // receipt — same skip outcome as an unmatched PaymentReleased.
    const SELF = '0xeE2a20AEF0f5F9B52FC334806256014F4DDcB8fc' as const;
    const window: GetLogsWindow = {
      created: [created({ jobId: BigInt(155689), client: SELF, provider: SELF })],
      released: [released({ jobId: BigInt(155689), provider: SELF, rawAmount: BigInt(100_000), txHash: '0xselfdeal' })],
    };
    const { deps, state } = makeDeps(window);
    const res = await arcJobsIndexer(deps);

    expect(res.fetched).toBe(0);
    expect(res.inserted).toBe(0);
    expect(state.inserted.length).toBe(0);
    expect(state.signals.length).toBe(0);
    expect(state.ensured.length).toBe(0);
    // cursor still advances so the self-dealt block is never re-scanned
    expect(state.cursors.length).toBe(1);
    expect(state.cursors[0][1]).toBe('120');
  });

  test('unmatched PaymentReleased IS indexed when resolveJobClient recovers the client', async () => {
    const window: GetLogsWindow = {
      created: [],
      released: [released({ jobId: BigInt(99), rawAmount: BigInt(7_000_000), txHash: '0xresolved', provider: PROVIDER_B })],
    };
    const { deps, state } = makeDeps(window, {
      resolveJobClient: async (jobId) => (jobId === BigInt(99) ? CLIENT_B : null),
    });
    const res = await arcJobsIndexer(deps);

    expect(res.fetched).toBe(1);
    expect(state.inserted[0].wallet_address).toBe(CLIENT_B);
    expect(state.signals.length).toBe(2);
    const consumer = state.signals.find((s) => (s as { face: string }).face === 'consumer') as Record<string, unknown>;
    expect(consumer.agentWallet).toBe(CLIENT_B);
    expect(consumer.txRef).toBe('99:0xresolved');
  });

  test('zero settlements in the window → no-op returns fetched:0 (cursor advances)', async () => {
    const window: GetLogsWindow = { created: [created({ jobId: BigInt(1) })], released: [] };
    const { deps, state } = makeDeps(window);
    const res = await arcJobsIndexer(deps);

    expect(res.fetched).toBe(0);
    expect(res.inserted).toBe(0);
    expect(state.inserted.length).toBe(0);
    expect(state.signals.length).toBe(0);
    // dry window still advances the cursor so it is not re-scanned
    expect(state.cursors[0][1]).toBe('120');
  });

  test('cursor already at/after head → no getLogs call, returns fetched:0', async () => {
    const window: GetLogsWindow = { created: [], released: [] };
    const { deps, state } = makeDeps(window, {
      getHead: async () => BigInt(100),
      getCursor: async () => ({ last_signature: '120', last_slot: 120 }), // start = 121 > head
    });
    const res = await arcJobsIndexer(deps);

    expect(res.fetched).toBe(0);
    expect(state.getLogsCalls).toBe(0); // skipped: nothing new to scan
    expect(res.cursors.get(arcJobsCursorKey(ARC_JOBS_CONTRACT))).toBe('100');
  });

  test('GENESIS_FALLBACK_BLOCK is the start when no cursor exists', async () => {
    const window: GetLogsWindow = { created: [], released: [] };
    const { deps, state } = makeDeps(window, { getHead: async () => BigInt(5) });
    await arcJobsIndexer(deps);
    expect(state.windows[0][0]).toBe(BigInt(GENESIS_FALLBACK_BLOCK));
  });
});
