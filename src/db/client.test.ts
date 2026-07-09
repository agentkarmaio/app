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

// Regression: /api/stats 500'd in prod (2026-06-18) because get_transaction_stats
// was missing from the DB (PGRST202) and getStats fell back to streaming the full
// transactions table (~502k rows) for a JS SUM — which blew the 8s statement
// timeout (57014) and THREW, with no try/catch in the route. getStats MUST treat
// the aggregate RPCs as the only source of truth and degrade to best-effort
// (never throw, never row-stream a full table) when an RPC is absent.
//
// The fake makes every aggregate RPC report PGRST202 and makes any non-HEAD
// `select` (the old `select('amount')` / `select('trust_tier')` row-streams)
// resolve with the prod statement-timeout error — so the pre-fix implementation,
// which threw on that error, fails this test, while the best-effort version passes.
describe('getStats degrades to best-effort when aggregate RPCs are missing', () => {
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

  test('returns best-effort numbers without throwing when both RPCs are absent', async () => {
    const fake = makeStatsFake({ txStats: null, tierRows: null, agentHeadCount: 103478 });
    __setSupabaseForTest(fake);

    const stats = await getStats(); // must not throw — the prod 500 was an uncaught throw

    expect(stats.totalTransactions).toBe(0);
    expect(stats.totalVolumeUsdc).toBe(0);
    expect(stats.tierDistribution).toEqual({});
    // totalAgents survives via a cheap HEAD count (no row scan) even with the RPC down.
    expect(stats.totalAgents).toBe(103478);
    // The HEAD count MUST target the canonical explore population (the same view
    // the Explore "All" count reads), NOT raw `wallets` — counting all wallet
    // rows (score=0 noise + owner-keyed celo/arc) is the homepage-vs-explore
    // mismatch this guards against.
    expect(fake.__fromTables).toContain('explore_agents');
    expect(fake.__fromTables).not.toContain('wallets');
  });

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
    expect(fake.__tablesQueried).not.toContain('wallets');
    expect(wallets.length).toBe(1);
  });
});
