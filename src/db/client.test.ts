/// <reference types="bun-types" />
/**
 * insertTransactions / cursor helpers / claimWallet — row-mapping + onConflict
 * targets + chain-scoping. We stub the Supabase client (set via
 * __setSupabaseForTest) and capture the upsert/insert/update payload, asserting
 * `chain` survives and conflict targets / existence lookups are chain-scoped.
 */
import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import {
  __setSupabaseForTest, insertTransactions, upsertCursor, getCursor, claimWallet,
  getStellarAgentId, setStellarAgentId, claimDirtyWallets, markWalletsDirty,
  ADDRESS_IN_CHUNK, getStats, getArcDashboardStats, normalizeCounterparty, getAgents,
  getTransactionsForWallets,
  getAllTransactions,
  markAllWalletsDirty,
  ensureWalletsExist,
  makeEnsureWallet,
  withTransientDbRetry,
} from './client';
import type { Transaction } from './schema';
import { ERC8183_SETTLED_KIND } from '@/scoring/settlement-quality';

// The injected fake lives in a module-level singleton shared across the whole
// `bun test` process. Without this teardown the last fake set here leaks into
// later test files (e.g. route tests calling getWallet().eq()), surfacing as
// "`.eq` is not a function". Reset to the real lazy client when this file ends.
afterAll(() => { __setSupabaseForTest(null); });

type Captured = { table: string; op: string; rows: unknown; opts: unknown };

function makeFakeSupabase(
  captured: Captured[],
  selectData: unknown[] = [],
  existingWallet: unknown = null,
) {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      builder.upsert = (rows: unknown, opts: unknown) => {
        captured.push({ table, op: 'upsert', rows, opts });
        return { select: async () => ({ data: selectData, error: null }) };
      };
      builder.insert = (rows: unknown) => {
        captured.push({ table, op: 'insert', rows, opts: null });
        return Promise.resolve({ error: null });
      };
      builder.update = (rows: unknown) => {
        captured.push({ table, op: 'update', rows, opts: null });
        // .update(...).eq(...).eq(...) chain resolves to { error: null }
        const chain: Record<string, unknown> = {};
        chain.eq = () => chain;
        chain.then = (resolve: (v: { error: null }) => void) => resolve({ error: null });
        return chain;
      };
      // chainable select().eq().single()/.maybeSingle() for getCursor + getWallet.
      // .single() is table-aware: getCursor reads indexer_cursors, getWallet reads
      // wallets (returns the injected existingWallet, defaulting to null → insert path).
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.single = async () => {
        if (table === 'indexer_cursors') {
          return {
            data: { chain: 'stellar', facilitator: 'CCW', last_signature: '7', last_slot: 7, updated_at: 'now' },
            error: null,
          };
        }
        // wallets: mimic PostgREST PGRST116 (no rows) when absent so getWallet returns null.
        return existingWallet
          ? { data: existingWallet, error: null }
          : { data: null, error: { code: 'PGRST116' } };
      };
      builder.maybeSingle = async () => ({ data: existingWallet, error: null });
      return builder;
    },
  };
}

describe('insertTransactions chain mapping', () => {
  let captured: Captured[];
  beforeEach(() => { captured = []; __setSupabaseForTest(makeFakeSupabase(captured, [{ id: '1' }])); });

  test('includes chain in the upserted row', async () => {
    const tx: Omit<Transaction, 'id'> = {
      chain: 'stellar', wallet_address: 'GABC', facilitator: 'GFAC',
      amount: 1, timestamp: '2026-06-06T00:00:00Z', success: true, tx_signature: 'deadbeef',
    };
    await insertTransactions([tx]);
    const rows = captured[0].rows as Array<Record<string, unknown>>;
    expect(rows[0].chain).toBe('stellar');
    expect(rows[0].tx_signature).toBe('deadbeef');
  });

  test('counterparty: self-payment and empty collapse to null; distinct kept', async () => {
    const base = { chain: 'celo' as const, facilitator: 'FAC', amount: 1, timestamp: '2026-06-06T00:00:00Z', success: true };
    await insertTransactions([
      { ...base, wallet_address: 'W1', counterparty: 'W1', tx_signature: 'self' },  // self-pay → null
      { ...base, wallet_address: 'W2', counterparty: '', tx_signature: 'empty' },    // empty → null
      { ...base, wallet_address: 'W3', counterparty: 'PAYEE', tx_signature: 'ok' },  // distinct → kept
    ]);
    const rows = captured[0].rows as Array<Record<string, unknown>>;
    expect(rows[0].counterparty).toBeNull();
    expect(rows[1].counterparty).toBeNull();
    expect(rows[2].counterparty).toBe('PAYEE');
  });
});

describe('normalizeCounterparty', () => {
  test('drops empty + self-payment, keeps a distinct counterparty', () => {
    expect(normalizeCounterparty(null, 'W')).toBeNull();
    expect(normalizeCounterparty(undefined, 'W')).toBeNull();
    expect(normalizeCounterparty('', 'W')).toBeNull();
    expect(normalizeCounterparty('W', 'W')).toBeNull(); // self-payment is not a counterparty
    expect(normalizeCounterparty('PAYEE', 'W')).toBe('PAYEE');
  });
});

describe('cursor helpers are chain-scoped', () => {
  let captured: Captured[];
  beforeEach(() => { captured = []; __setSupabaseForTest(makeFakeSupabase(captured)); });

  test('upsertCursor writes chain and conflicts on (chain,facilitator)', async () => {
    await upsertCursor('CCW', '7', 7, 'stellar');
    const row = captured[0].rows as Record<string, unknown>;
    expect(row.chain).toBe('stellar');
    expect((captured[0].opts as { onConflict: string }).onConflict).toBe('chain,facilitator');
  });

  test('getCursor filters by chain and returns the row', async () => {
    const c = await getCursor('CCW', 'stellar');
    expect(c?.chain).toBe('stellar');
  });
});

describe('claimWallet is chain-aware (C1)', () => {
  let captured: Captured[];

  test("a 'stellar' claim inserts chain:'stellar' when no wallet exists", async () => {
    captured = [];
    __setSupabaseForTest(makeFakeSupabase(captured, [], null));
    await claimWallet('GAGENT', 'Agent', null, null, null, null, 'stellar');
    const insertOp = captured.find((c) => c.op === 'insert');
    expect(insertOp).toBeDefined();
    const row = insertOp!.rows as Record<string, unknown>;
    expect(row.chain).toBe('stellar');
    expect(row.address).toBe('GAGENT');
  });

  test("a 'stellar' claim updates chain:'stellar' when the wallet exists", async () => {
    captured = [];
    __setSupabaseForTest(makeFakeSupabase(captured, [], { chain: 'stellar', address: 'GAGENT' }));
    await claimWallet('GAGENT', 'Agent', null, null, null, null, 'stellar');
    const updateOp = captured.find((c) => c.op === 'update');
    expect(updateOp).toBeDefined();
    const row = updateOp!.rows as Record<string, unknown>;
    expect(row.chain).toBe('stellar');
  });
});

describe('claimWallet persists ownership proof', () => {
  let captured: Captured[];

  test('insert path includes claim_signature + claim_message when proof passed', async () => {
    captured = [];
    __setSupabaseForTest(makeFakeSupabase(captured, [], null));
    await claimWallet('GAGENT', 'Agent', null, null, null, null, 'stellar', {
      signature: 'SIG',
      message: 'MSG',
    });
    const row = captured.find((c) => c.op === 'insert')!.rows as Record<string, unknown>;
    expect(row.claim_signature).toBe('SIG');
    expect(row.claim_message).toBe('MSG');
  });

  test('update path includes proof when the wallet already exists', async () => {
    captured = [];
    __setSupabaseForTest(makeFakeSupabase(captured, [], { chain: 'stellar', address: 'GAGENT' }));
    await claimWallet('GAGENT', 'Agent', null, null, null, null, 'stellar', {
      signature: 'SIG2',
      message: 'MSG2',
    });
    const row = captured.find((c) => c.op === 'update')!.rows as Record<string, unknown>;
    expect(row.claim_signature).toBe('SIG2');
    expect(row.claim_message).toBe('MSG2');
  });

  test('proof-less claim omits the keys entirely (never wipes a stored proof)', async () => {
    captured = [];
    __setSupabaseForTest(makeFakeSupabase(captured, [], { chain: 'stellar', address: 'GAGENT' }));
    await claimWallet('GAGENT', 'Agent', null, null, null, null, 'stellar');
    const row = captured.find((c) => c.op === 'update')!.rows as Record<string, unknown>;
    expect('claim_signature' in row).toBe(false);
    expect('claim_message' in row).toBe(false);
  });
});

describe('stellar_agent_id getter/setter (C2)', () => {
  let captured: Captured[];

  test('getStellarAgentId returns the stored agentId', async () => {
    captured = [];
    __setSupabaseForTest(makeFakeSupabase(captured, [], { stellar_agent_id: 9058 }));
    const id = await getStellarAgentId('GAGENT');
    expect(id).toBe(9058);
  });

  test('getStellarAgentId returns null when wallet absent', async () => {
    captured = [];
    __setSupabaseForTest(makeFakeSupabase(captured, [], null));
    const id = await getStellarAgentId('GMISSING');
    expect(id).toBeNull();
  });

  test('getStellarAgentId returns null when column is null', async () => {
    captured = [];
    __setSupabaseForTest(makeFakeSupabase(captured, [], { stellar_agent_id: null }));
    const id = await getStellarAgentId('GAGENT');
    expect(id).toBeNull();
  });

  test("setStellarAgentId writes the column chain-scoped to stellar", async () => {
    captured = [];
    __setSupabaseForTest(makeFakeSupabase(captured, [], { chain: 'stellar', address: 'GAGENT' }));
    await setStellarAgentId('GAGENT', 9058);
    const updateOp = captured.find((c) => c.op === 'update' && c.table === 'wallets');
    expect(updateOp).toBeDefined();
    const row = updateOp!.rows as Record<string, unknown>;
    expect(row.stellar_agent_id).toBe(9058);
  });
});

// Regression: the scoring drain stalled in prod with PostgREST 'URI too long'
// because the dirty-queue cleared/marked wallets with a single oversized
// `.in('address', [...])` filter (200 base58 addrs ≈ 9.2KB > Kong's ~8KB URI
// cap). Every address-list `.in()` MUST be chunked to <=ADDRESS_IN_CHUNK so no
// request URL overflows. These tests drive a fake that records each `.in()`
// list and asserts no chunk exceeds the cap while every address is covered.
describe('dirty-queue chunks address .in() lists to avoid URI-too-long', () => {
  function fakeRecordingIn(selectRows: { address: string }[], inCalls: string[][]) {
    return {
      from() {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.not = () => b;
        b.order = () => b;
        b.limit = async () => ({ data: selectRows, error: null });
        b.update = () => ({
          in: (_col: string, list: string[]) => {
            inCalls.push(list);
            return Promise.resolve({ error: null });
          },
        });
        return b;
      },
    };
  }

  test('ADDRESS_IN_CHUNK keeps a base58 .in() URL safely under the ~8KB cap', () => {
    // ~46 chars/base58 addr + ',' separator; the encoded filter must stay < 8KB.
    expect(ADDRESS_IN_CHUNK * 47).toBeLessThan(8000);
  });

  test('claimDirtyWallets clears 200 wallets in <=ADDRESS_IN_CHUNK-sized chunks', async () => {
    const addresses = Array.from({ length: 200 }, (_, i) => `Wa11et${String(i).padStart(38, '0')}`);
    const inCalls: string[][] = [];
    __setSupabaseForTest(fakeRecordingIn(addresses.map((address) => ({ address })), inCalls));

    const claimed = await claimDirtyWallets(200);

    expect(claimed.length).toBe(200);
    expect(inCalls.length).toBeGreaterThan(1); // chunked, not one giant .in()
    expect(Math.max(...inCalls.map((c) => c.length))).toBeLessThanOrEqual(ADDRESS_IN_CHUNK);
    expect(inCalls.flat().sort()).toEqual([...addresses].sort()); // every wallet cleared
  });

  test('markWalletsDirty marks 250 wallets in <=ADDRESS_IN_CHUNK-sized chunks', async () => {
    const addresses = Array.from({ length: 250 }, (_, i) => `Wa11et${String(i).padStart(38, '0')}`);
    const inCalls: string[][] = [];
    __setSupabaseForTest(fakeRecordingIn([], inCalls));

    await markWalletsDirty(addresses);

    expect(Math.max(...inCalls.map((c) => c.length))).toBeLessThanOrEqual(ADDRESS_IN_CHUNK);
    expect(inCalls.flat().sort()).toEqual([...addresses].sort());
  });
});

// Two prod incidents define getStats's failure contract:
//   2026-06-18 — get_transaction_stats missing (PGRST202) made getStats fall
//     back to streaming the full transactions table, blow the 8s statement
//     timeout (57014), and 500 /api/stats. Invariant: aggregate RPCs are the
//     only source of truth; NEVER row-stream a full table as a fallback.
//   2026-07-29 — a transient RPC failure was masked as totalTransactions=0 /
//     totalVolumeUsdc=0 served with HTTP 200, firing the external
//     "counters regressed" monitor. Invariant: NEVER fabricate figures — on
//     RPC failure serve the last-known-good in-process values; with nothing
//     good to serve (cold start), THROW so callers degrade honestly
//     (pages already .catch(() => null); /api/stats returns 503).
//
// The fake makes any non-HEAD `select` (the old row-streams) resolve with the
// prod statement-timeout error, so a row-streaming regression fails loudly.
describe('getStats failure contract: stale-on-error, throw-on-cold, no row-streams', () => {
  const PGRST202 = { code: 'PGRST202', message: 'function not found in schema cache' };
  const TIMEOUT_57014 = { code: '57014', message: 'canceling statement due to statement timeout' };

  function makeStatsFake(opts: {
    txStats?: { total_count: number; total_volume: number } | null;
    tierRows?: { trust_tier: string; count: number }[] | null;
    agentHeadCount?: number;
  }) {
    const fromTables: string[] = [];
    return {
      // Tables touched, in call order — lets a test assert WHICH population the
      // agent count is read from (must be the canonical `explore_agents` view).
      __fromTables: fromTables,
      rpc(name: string) {
        if (name === 'get_transaction_stats') {
          const result = opts.txStats
            ? { data: opts.txStats, error: null }
            : { data: null, error: PGRST202 };
          return { single: async () => result };
        }
        if (name === 'get_tier_distribution') {
          return Promise.resolve(
            opts.tierRows ? { data: opts.tierRows, error: null } : { data: null, error: PGRST202 },
          );
        }
        return Promise.resolve({ data: null, error: PGRST202 });
      },
      from(table: string) {
        fromTables.push(table);
        const b: Record<string, unknown> = {};
        b.select = (_cols: string, selOpts?: { head?: boolean; count?: string }) =>
          selOpts?.head
            ? Promise.resolve({ count: opts.agentHeadCount ?? 0, error: null })
            // Any full-table row-stream is the exact prod failure — surface 57014.
            : Promise.resolve({ data: null, error: TIMEOUT_57014 });
        return b;
      },
    };
  }

  test('reads real figures from the aggregate RPCs when they are deployed', async () => {
    __setSupabaseForTest(makeStatsFake({
      txStats: { total_count: 502474, total_volume: 1234.56 },
      tierRows: [
        { trust_tier: 'Excellent', count: 10 },
        { trust_tier: 'Good', count: 90 },
      ],
    }));

    const stats = await getStats();

    expect(stats.totalTransactions).toBe(502474);
    expect(stats.totalVolumeUsdc).toBe(1234.56);
    expect(stats.tierDistribution).toEqual({ Excellent: 10, Good: 90 });
    expect(stats.totalAgents).toBe(100); // summed from the tier RPC, no HEAD count needed
  });

  test('throws on a cold tx-stats failure instead of fabricating zeros', async () => {
    // __setSupabaseForTest resets the stale figures — this IS the cold path.
    __setSupabaseForTest(makeStatsFake({ txStats: null, tierRows: null, agentHeadCount: 103478 }));

    // 0 tx / 0 volume with HTTP 200 is the 2026-07-29 false alert. With no
    // last-known-good to serve, the only honest behavior is to throw.
    await expect(getStats()).rejects.toThrow(/get_transaction_stats/);
  });

  test('serves last-known-good tx figures when the RPC fails after a prior success', async () => {
    const fake = makeStatsFake({
      txStats: { total_count: 838401, total_volume: 273685.73 },
      tierRows: [{ trust_tier: 'Good', count: 106101 }],
    });
    __setSupabaseForTest(fake);
    await getStats(); // primes the last-known-good figures

    // Same DB identity, transient RPC failure (the 08:01 statement timeout) —
    // swap the rpc handler in place so the stale state survives.
    fake.rpc = ((name: string) => {
      if (name === 'get_transaction_stats') {
        return { single: async () => ({ data: null, error: TIMEOUT_57014 }) };
      }
      if (name === 'get_tier_distribution') {
        return Promise.resolve({ data: [{ trust_tier: 'Good', count: 106145 }], error: null });
      }
      return Promise.resolve({ data: null, error: PGRST202 });
    }) as typeof fake.rpc;

    const stats = await getStats();

    // Stale tx figures, never 0 — and fresh figures where the RPCs still work.
    expect(stats.totalTransactions).toBe(838401);
    expect(stats.totalVolumeUsdc).toBe(273685.73);
    expect(stats.totalAgents).toBe(106145);
  });

  test('tier RPC failure degrades to a HEAD count over the canonical explore view', async () => {
    const fake = makeStatsFake({
      txStats: { total_count: 100, total_volume: 5 },
      tierRows: null,
      agentHeadCount: 103478,
    });
    __setSupabaseForTest(fake);

    const stats = await getStats();

    // totalAgents survives via a cheap HEAD count (no row scan) even with the RPC down.
    expect(stats.totalAgents).toBe(103478);
    expect(stats.tierDistribution).toEqual({});
    // The HEAD count MUST target the canonical explore population (the same view
    // the Explore "All" count reads), NOT raw `wallets` — counting all wallet
    // rows (score=0 noise + owner-keyed celo/arc) is the homepage-vs-explore
    // mismatch this guards against.
    expect(fake.__fromTables).toContain('explore_agents');
    expect(fake.__fromTables).not.toContain('wallets');
  });
});

// Arc grant-demo dashboard: chain-filtered bounded reads + best-effort degrade.
describe('getArcDashboardStats', () => {
  function makeArcDashFake(opts: {
    txs?: { amount: string; wallet_address: string; counterparty: string }[];
    recent?: {
      tx_signature: string;
      wallet_address: string;
      counterparty: string;
      amount: string;
      timestamp: string;
    }[];
    signals?: {
      agent_wallet: string;
      kind: string;
      face: string;
      signed_by: string;
      payload?: unknown;
    }[];
    registryAgents?: number;
    registryFeedbacks?: number;
    failTxs?: boolean;
  }) {
    const chainable = (resolve: () => Promise<{ data: unknown; error: unknown; count?: number }>) => {
      const b: Record<string, unknown> = {};
      const self = () => b;
      b.select = () => b;
      b.eq = () => b;
      b.order = () => b;
      b.limit = () => resolve();
      // HEAD-count paths used by getRegistryStats resolve without .limit
      b.then = undefined;
      // When select is called with head:true, PostgREST returns immediately after eq
      // — our chainable returns `b` from eq; make it thenable for head paths.
      const makeThenable = (p: Promise<{ data: unknown; error: unknown; count?: number }>) => {
        (b as { then?: unknown }).then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          p.then(onFulfilled, onRejected);
        return b;
      };
      // Re-bind select to detect head counts
      b.select = (_cols: string, selOpts?: { head?: boolean }) => {
        if (selOpts?.head) {
          return makeThenable(resolve());
        }
        return b;
      };
      b.eq = self;
      b.order = self;
      b.limit = () => resolve();
      return b;
    };

    return {
      from(table: string) {
        if (table === 'erc8004_agents') {
          return chainable(async () => ({
            data: null,
            error: null,
            count: opts.registryAgents ?? 0,
          }));
        }
        if (table === 'erc8004_feedback') {
          return chainable(async () => ({
            data: null,
            error: null,
            count: opts.registryFeedbacks ?? 0,
          }));
        }
        if (table === 'signal_events') {
          return chainable(async () => ({
            data: opts.signals ?? [],
            error: null,
          }));
        }
        // transactions — first call is agg select, second is recent (order+limit)
        // The fake doesn't distinguish; return txs for any non-recent-shaped need.
        // Call order in getArcDashboardStats: txs (no order), then recent (order).
        let txCall = 0;
        const txState = { n: 0 };
        return {
          select: (_cols: string, selOpts?: { head?: boolean }) => {
            const b: Record<string, unknown> = {};
            let ordered = false;
            b.eq = () => b;
            b.order = () => {
              ordered = true;
              return b;
            };
            b.limit = async () => {
              if (opts.failTxs) {
                return { data: null, error: { message: 'boom' } };
              }
              if (selOpts?.head) {
                return { data: null, error: null, count: (opts.txs ?? []).length };
              }
              if (ordered) {
                return { data: opts.recent ?? opts.txs ?? [], error: null };
              }
              txState.n += 1;
              txCall = txState.n;
              void txCall;
              // First select is amount/wallet/counterparty (no order)
              if (_cols.includes('amount') && !_cols.includes('tx_signature')) {
                return { data: opts.txs ?? [], error: null };
              }
              return { data: opts.recent ?? [], error: null };
            };
            return b;
          },
        };
      },
    };
  }

  test('aggregates matched settlements + quality + recent', async () => {
    __setSupabaseForTest(makeArcDashFake({
      registryAgents: 845_000,
      registryFeedbacks: 2_980,
      txs: [
        { amount: '10', wallet_address: '0xclient', counterparty: '0xprov' },
        { amount: '5', wallet_address: '0xclient2', counterparty: '0xprov' },
      ],
      recent: [
        {
          tx_signature: '1:0xabc',
          wallet_address: '0xclient',
          counterparty: '0xprov',
          amount: '10',
          timestamp: '2026-07-01T00:00:00Z',
        },
      ],
      signals: [
        // 3 distinct CPs → reliable
        { agent_wallet: '0xprov', kind: ERC8183_SETTLED_KIND, face: 'provider', signed_by: '0xa' },
        { agent_wallet: '0xprov', kind: ERC8183_SETTLED_KIND, face: 'provider', signed_by: '0xb' },
        { agent_wallet: '0xprov', kind: ERC8183_SETTLED_KIND, face: 'provider', signed_by: '0xc' },
      ],
    }));

    const stats = await getArcDashboardStats();

    expect(stats.matchedSettlements).toBe(2);
    expect(stats.volumeUsdc).toBe(15);
    expect(stats.agentsWithReceipts).toBe(1);
    expect(stats.quality.reliable).toBe(1);
    expect(stats.recent).toHaveLength(1);
    expect(stats.recent[0].txHash).toBe('0xabc');
    expect(stats.registry.agents).toBe(845_000);
    expect(stats.empty).toBe(false);
  });

  test('degrades to empty zeros without throwing when queries fail', async () => {
    __setSupabaseForTest(makeArcDashFake({ failTxs: true, registryAgents: 10 }));
    const stats = await getArcDashboardStats();
    expect(stats.matchedSettlements).toBe(0);
    expect(stats.empty).toBe(true);
    expect(stats.registry.agents).toBe(10);
  });
});

// Regression: Explore `claimed=true` on Celo/Arc returned the whole ERC-8004
// registry mirror (9,529 agents on celo), all rendered claimed:false — the
// claimed filter was silently ignored. Claimed EVM agents live in `wallets`
// (claimWallet writes there), NOT the registry mirror, which is always
// claimed:false. So `claimed=true` MUST read `wallets`; only the unfiltered /
// claimed!=true population reads the registry. These tests drive a table-aware
// fake and assert the routing + that every returned row is actually claimed.
describe('getAgents routes claimed=true for registry chains to wallets', () => {
  const SORT = { field: 'provider_score' as const, direction: 'desc' as const };

  // Chainable builder: every query method returns the builder; the terminal
  // .range() resolves to { data, count } sourced from whichever table .from()
  // named. Records the tables queried so we can assert the routing decision.
  function makeAgentsFake(opts: { registryRows: unknown[]; walletRows: unknown[] }) {
    const tablesQueried: string[] = [];
    return {
      __tablesQueried: tablesQueried,
      from(table: string) {
        tablesQueried.push(table);
        const rows = table === 'wallets' ? opts.walletRows : opts.registryRows;
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'gt', 'gte', 'lt', 'in', 'or', 'order', 'not', 'limit']) {
          b[m] = () => b;
        }
        b.range = async () => ({ data: rows, error: null, count: rows.length });
        return b;
      },
    };
  }

  // A raw erc8004_agents row (declared-only, always claimed:false once mapped).
  const registryRow = {
    agent_id: 1, metadata_score: 100, registration: { name: 'Arca' },
    owner: '0xowner', agent_wallet: '0xwallet',
    first_indexed_at: '2026-06-20T00:00:00Z', last_indexed_at: '2026-06-20T00:00:00Z',
  };
  // A claimed wallet row for the same chain (this is where claims actually land).
  const claimedWalletRow = {
    chain: 'celo', address: '0xclaimed', claimed: true, display_name: 'Claimed Agent',
    score: 50, trust_tier: 'Fair', provider_score: 50, consumer_score: null,
    confidence_badge: 'declared', tx_count: 3, last_seen: '2026-06-22T00:00:00Z',
  };

  test('claimed=true on celo reads wallets and returns only claimed rows', async () => {
    const fake = makeAgentsFake({ registryRows: [registryRow], walletRows: [claimedWalletRow] });
    __setSupabaseForTest(fake);

    const { wallets, total } = await getAgents(25, 0, { chain: 'celo', claimed: true }, SORT);

    expect(fake.__tablesQueried).toContain('wallets');
    expect(fake.__tablesQueried).not.toContain('erc8004_agents');
    expect(wallets.length).toBeGreaterThan(0);
    expect(wallets.every((w) => w.claimed === true)).toBe(true); // pre-fix: registry rows were claimed:false
    expect(total).toBe(1);
  });

  test('celo without claimed=true still reads the registry mirror (full population)', async () => {
    const fake = makeAgentsFake({ registryRows: [registryRow], walletRows: [claimedWalletRow] });
    __setSupabaseForTest(fake);

    const { wallets } = await getAgents(25, 0, { chain: 'celo' }, SORT);

    expect(fake.__tablesQueried).toContain('erc8004_agents');
    // The POPULATION must come from the mirror: exactly the registry row, never
    // the claimed wallet row. (`wallets` is also touched, but only for the
    // bounded per-page behavioral lookup — see getBehaviorForAddresses.)
    expect(wallets.length).toBe(1);
    expect(wallets[0].display_name).toBe('Arca');
    expect(wallets[0].claimed).toBe(false);
  });

  // Stellar joined the registry-mirror set on 2026-08-05. Its 67 registered
  // agentIds collapse to 11 owner rows in `wallets` (one registrant holds ~10
  // agents), so routing it through the wallets path hid 56 agents.
  test('stellar without claimed=true reads the registry mirror', async () => {
    const stellarRegistryRow = {
      agent_id: 66, metadata_score: 90, registration: { name: 'AgentKarma' },
      owner: 'GA6OBKNS', agent_wallet: 'GA6OBKNS',
      first_indexed_at: '2026-08-05T00:00:00Z', last_indexed_at: '2026-08-05T00:00:00Z',
    };
    const fake = makeAgentsFake({ registryRows: [stellarRegistryRow], walletRows: [claimedWalletRow] });
    __setSupabaseForTest(fake);

    const { wallets } = await getAgents(25, 0, { chain: 'stellar' }, SORT);

    expect(fake.__tablesQueried).toContain('erc8004_agents');
    expect(wallets.length).toBe(1);
    expect(wallets[0].display_name).toBe('AgentKarma');
    // The agentId must land on the Stellar-specific column so /agent/G… resolves.
    expect(wallets[0].stellar_agent_id).toBe(66);
    expect(wallets[0].celo_agent_id).toBeNull();
  });

  test('claimed=true on stellar reads wallets, not the mirror', async () => {
    const fake = makeAgentsFake({
      registryRows: [registryRow],
      walletRows: [{ ...claimedWalletRow, chain: 'stellar', address: 'GCLAIMED' }],
    });
    __setSupabaseForTest(fake);

    const { wallets } = await getAgents(25, 0, { chain: 'stellar', claimed: true }, SORT);

    expect(fake.__tablesQueried).toContain('wallets');
    expect(fake.__tablesQueried).not.toContain('erc8004_agents');
    expect(wallets.every((w) => w.claimed === true)).toBe(true);
  });
});

// ── getTransactionsForWallets: per-wallet bounded reads ──────────────────────
//
// Regression for the 2026-07-22 `57014 canceling statement due to statement
// timeout`. The old shape was `.in(wallet_address, chunk).order(timestamp)`
// with NO limit — unbounded full history for every affected wallet across a
// 786k-row table. It aborted runIndexer AFTER insertTransactions but BEFORE
// scoring, so transactions landed and scores silently didn't.
//
// The bound must be PER WALLET (matching the 5000-row TX_WINDOW convention in
// rescore-dirty / instrumentation), not a single global .limit() — a global cap
// would let one busy wallet starve every other wallet in the batch.
describe('getTransactionsForWallets bounds history per wallet', () => {
  type Query = { table: string; eq: [string, unknown][]; limit: number | null };

  function makeTxFake(rowsFor: (addr: string) => unknown[]) {
    const queries: Query[] = [];
    return {
      queries,
      from(table: string) {
        const q: Query = { table, eq: [], limit: null };
        const builder: Record<string, unknown> = {};
        builder.select = () => builder;
        builder.in = () => { throw new Error('unbounded .in() query — must fetch per wallet'); };
        builder.eq = (col: string, val: unknown) => { q.eq.push([col, val]); return builder; };
        builder.order = () => builder;
        builder.limit = (n: number) => {
          q.limit = n;
          queries.push(q);
          const addr = q.eq.find(([c]) => c === 'wallet_address')?.[1] as string;
          return Promise.resolve({ data: rowsFor(addr), error: null });
        };
        return builder;
      },
    };
  }

  afterAll(() => { __setSupabaseForTest(null); });

  test('applies a per-wallet row limit instead of an unbounded scan', async () => {
    const fake = makeTxFake(() => []);
    __setSupabaseForTest(fake);

    await getTransactionsForWallets(['walletA', 'walletB']);

    expect(fake.queries).toHaveLength(2); // one bounded query per wallet
    expect(fake.queries.every((q) => q.limit !== null && q.limit > 0)).toBe(true);
    expect(fake.queries.map((q) => q.eq).flat()).toEqual([
      ['wallet_address', 'walletA'],
      ['wallet_address', 'walletB'],
    ]);
  });

  test('honours a caller-supplied window', async () => {
    const fake = makeTxFake(() => []);
    __setSupabaseForTest(fake);

    await getTransactionsForWallets(['walletA'], 250);

    expect(fake.queries[0].limit).toBe(250);
  });

  test('returns every wallet rows, each capped independently', async () => {
    // walletA is the busy one — under a single global cap it would swallow the
    // whole budget and walletB would score off zero transactions.
    const fake = makeTxFake((addr) =>
      addr === 'walletA'
        ? Array.from({ length: 3 }, (_, i) => ({ wallet_address: 'walletA', id: `a${i}` }))
        : [{ wallet_address: 'walletB', id: 'b0' }],
    );
    __setSupabaseForTest(fake);

    const rows = await getTransactionsForWallets(['walletA', 'walletB'], 3);

    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.wallet_address === 'walletB')).toHaveLength(1);
  });

  test('no wallets means no query at all', async () => {
    const fake = makeTxFake(() => []);
    __setSupabaseForTest(fake);

    expect(await getTransactionsForWallets([])).toEqual([]);
    expect(fake.queries).toHaveLength(0);
  });
});

// ── getAllTransactions: no unbounded reads, no silent truncation ─────────────
//
// This issued `select('*').order(timestamp)` with no limit at all — a full read
// of the transactions table (786k rows as of 2026-07-22). Two failure modes,
// both bad: the query times out (57014), or PostgREST's row cap trims the
// result and the caller scores off a silently truncated history.
//
// A bound is now required at the call site, and hitting it raises instead of
// returning a short list — a truncated "all transactions" is wrong data, not a
// smaller answer.
describe('getAllTransactions refuses unbounded and truncated reads', () => {
  function makeCapFake(rowCount: number) {
    const seen: { limit: number | null } = { limit: null };
    return {
      seen,
      from() {
        const builder: Record<string, unknown> = {};
        builder.select = () => builder;
        builder.order = () => builder;
        builder.limit = (n: number) => {
          seen.limit = n;
          return Promise.resolve({
            data: Array.from({ length: rowCount }, (_, i) => ({ id: `t${i}` })),
            error: null,
          });
        };
        return builder;
      },
    };
  }

  afterAll(() => { __setSupabaseForTest(null); });

  test('always applies the caller-supplied bound to the query', async () => {
    const fake = makeCapFake(10);
    __setSupabaseForTest(fake);

    await getAllTransactions(500);

    expect(fake.seen.limit).toBe(500);
  });

  test('throws when the result fills the bound — truncation is never silent', async () => {
    const fake = makeCapFake(500); // exactly the cap → cannot tell if more exist
    __setSupabaseForTest(fake);

    await expect(getAllTransactions(500)).rejects.toThrow(/truncat/i);
  });

  test('returns normally when the result is comfortably inside the bound', async () => {
    const fake = makeCapFake(12);
    __setSupabaseForTest(fake);

    expect(await getAllTransactions(500)).toHaveLength(12);
  });
});

// ── markAllWalletsDirty ─────────────────────────────────────────────────────
//
// Backs the /api/score/refresh full-rescore path. Enqueueing is one UPDATE; the
// existing scoring worker then drains at its own bounded rate. The alternative
// the route used to take — read 786k txs, then loop ~105k wallets serially —
// could not complete.
describe('markAllWalletsDirty enqueues instead of rescoring inline', () => {
  function makeUpdateFake(count: number) {
    const calls: { table: string; patch: Record<string, unknown>; filtered: boolean }[] = [];
    return {
      calls,
      from(table: string) {
        return {
          update(patch: Record<string, unknown>) {
            const call = { table, patch, filtered: false };
            calls.push(call);
            const chain: Record<string, unknown> = {};
            // PostgREST refuses an unfiltered UPDATE, so a filter must be present.
            chain.not = () => { call.filtered = true; return Promise.resolve({ count, error: null }); };
            return chain;
          },
        };
      },
    };
  }

  afterAll(() => { __setSupabaseForTest(null); });

  test('stamps scoring_dirty_at on wallets under a filter, and reports the count', async () => {
    const fake = makeUpdateFake(105_952);
    __setSupabaseForTest(fake);

    const queued = await markAllWalletsDirty();

    expect(queued).toBe(105_952);
    expect(fake.calls).toHaveLength(1); // one statement, not one per wallet
    expect(fake.calls[0].table).toBe('wallets');
    expect(fake.calls[0].patch.scoring_dirty_at).toBeTruthy();
    expect(fake.calls[0].filtered).toBe(true);
  });
});

// ── ensureWalletsExist ──────────────────────────────────────────────────────
//
// Regression: 2026-08-02 totalAgents dips. Every ingest path (Helius webhook,
// Solana/Stellar indexers, bond projector) "ensured" wallet rows for the
// transactions/signal_events FK with upsertWallet(addr, 0, 'Unrated', 0) — but
// a plain upsert is ON CONFLICT DO UPDATE, so each ingest burst overwrote live
// score/tx_count with zeros, knocking scored wallets out of `explore_agents`
// (score > 0) until the next rescore and firing the external counter-regression
// monitor. Ensure MUST be insert-if-absent: ON CONFLICT DO NOTHING.
describe('ensureWalletsExist is insert-if-absent, never an overwrite', () => {
  let captured: Captured[];
  beforeEach(() => { captured = []; __setSupabaseForTest(makeFakeSupabase(captured)); });
  afterAll(() => { __setSupabaseForTest(null); });

  test('one batched upsert with ignoreDuplicates; rows carry only the identity', async () => {
    await ensureWalletsExist(['W1', 'W2', 'W1'], 'solana');

    const calls = captured.filter((c) => c.table === 'wallets');
    expect(calls).toHaveLength(1); // one statement, not one per wallet
    expect(calls[0].op).toBe('upsert');
    // ignoreDuplicates → ON CONFLICT DO NOTHING: existing rows stay untouched.
    expect(calls[0].opts).toEqual({ onConflict: 'chain,address', ignoreDuplicates: true });
    // Identity only — score/trust_tier/tx_count come from schema defaults on
    // INSERT and must never appear here, or a conflict update would zero them.
    expect(calls[0].rows).toEqual([
      { chain: 'solana', address: 'W1' },
      { chain: 'solana', address: 'W2' },
    ]);
  });

  test('defaults to the solana chain and skips the round-trip on empty input', async () => {
    await ensureWalletsExist([]);
    expect(captured).toHaveLength(0);

    await ensureWalletsExist(['W9']);
    expect((captured[0].rows as Array<Record<string, unknown>>)[0].chain).toBe('solana');
  });

  // Every indexer takes an injected single-address `ensureWallet` dep. When each
  // wired its own closure, the 2026-08-02 fix migrated the Solana/Stellar sites
  // to insert-if-absent and MISSED arc-jobs, arc-transfers and celo-x402, which
  // kept calling upsertWallet(addr, 0, 'Unrated', 0) — the score-zeroing shape.
  // One canonical factory means there is no second place to drift.
  test('makeEnsureWallet produces an insert-if-absent dep bound to its chain', async () => {
    await makeEnsureWallet('arc')('0xABC');

    expect(captured).toHaveLength(1);
    expect(captured[0].op).toBe('upsert');
    expect(captured[0].opts).toEqual({ onConflict: 'chain,address', ignoreDuplicates: true });
    expect(captured[0].rows).toEqual([{ chain: 'arc', address: '0xABC' }]);
  });
});

// ── ensureWalletsExist: transient-timeout resilience ────────────────────────
//
// Regression: 2026-08-09 keep-fresh FLOOR FAILED. A 141-row insert-if-absent —
// trivially small — came back `57014 canceling statement due to statement
// timeout` under momentary DB contention, and the unretried throw killed the
// whole out-of-process ingest floor (exit 1, Telegram page). The next three
// scheduled runs were green, so the query is not the problem; a floor whose job
// is surviving outages must not die on one transient cancel. Retry is safe here
// precisely because ON CONFLICT DO NOTHING makes the statement idempotent.
describe('ensureWalletsExist survives a transient statement timeout', () => {
  afterAll(() => { __setSupabaseForTest(null); });

  /** Fails the first `failures` upserts with `error`, then succeeds. */
  function makeFlakySupabase(failures: number, error: { code: string; message?: string }) {
    let attempts = 0;
    const state = { attempts: 0 };
    __setSupabaseForTest({
      from() {
        return {
          upsert: async () => {
            attempts++;
            state.attempts = attempts;
            return attempts <= failures ? { error } : { error: null };
          },
        };
      },
    });
    return state;
  }

  test('retries a 57014 statement timeout instead of failing the run', async () => {
    const state = makeFlakySupabase(1, {
      code: '57014',
      message: 'canceling statement due to statement timeout',
    });
    await ensureWalletsExist(['W1', 'W2'], 'solana'); // one real ~1s backoff
    expect(state.attempts).toBe(2); // cancelled once, then through
  }, 15_000);

  test('a non-transient error is rethrown immediately, without burning retries', async () => {
    const state = makeFlakySupabase(99, { code: '23503', message: 'foreign key violation' });
    await expect(ensureWalletsExist(['W1'])).rejects.toMatchObject({ code: '23503' });
    expect(state.attempts).toBe(1);
  });
});

// The retry budget and classifier themselves, with the backoff wound down so
// the give-up path is testable without a 7-second wait.
describe('withTransientDbRetry', () => {
  const fast = { baseMs: 1, jitter: false };

  test('gives up after the budget so a persistent stall still pages', async () => {
    let calls = 0;
    await expect(
      withTransientDbRetry(async () => {
        calls++;
        throw { code: '57014', message: 'canceling statement' };
      }, { ...fast, retries: 3 }),
    ).rejects.toMatchObject({ code: '57014' });
    expect(calls).toBe(4); // initial + 3 retries
  });

  test('retries serialization failures and deadlock victims too', async () => {
    for (const code of ['40001', '40P01']) {
      let calls = 0;
      await withTransientDbRetry(async () => {
        calls++;
        if (calls === 1) throw { code };
      }, fast);
      expect(calls).toBe(2);
    }
  });

  test('never retries a schema or constraint error', async () => {
    let calls = 0;
    await expect(
      withTransientDbRetry(async () => {
        calls++;
        throw { code: '42703', message: 'column does not exist' };
      }, fast),
    ).rejects.toMatchObject({ code: '42703' });
    expect(calls).toBe(1);
  });
});
