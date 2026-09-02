/// <reference types="bun-types" />
/**
 * resolveKarmaEnrichment — the best-effort orchestrator behind the enriched
 * score response. Fake Supabase keyed by table: a throwing table must omit
 * ONLY its block; the core-derived `rankScore` + `explain` always ship.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { __setSupabaseForTest } from '@/db/client';
import { resolveKarma, resolveKarmaEnrichment } from './karma-resolver';
import type { Wallet } from '@/db/schema';

const OWNER = '0x558e7bfaf2cf1a494f44e50d92431afc060c9d12';

type TableSpec = { rows?: unknown[]; count?: number; error?: { message: string } };

/** Chainable fake: every builder method returns itself; awaiting resolves the table spec.
 *  `filters` records every eq/or argument so boundary normalization is observable. */
function makeFakeSupabase(tables: Record<string, TableSpec>, calls: string[] = [], filters: string[] = []) {
  return {
    from(table: string) {
      calls.push(table);
      const spec = tables[table] ?? { rows: [] };
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'in', 'order', 'limit', 'range', 'gte', 'lte', 'is', 'not']) b[m] = () => b;
      b.maybeSingle = async () => ({ data: (spec.rows ?? [])[0] ?? null, error: null });
      b.eq = (col: string, v: unknown) => { filters.push(`${table}.${col}=${String(v)}`); return b; };
      b.or = (expr: string) => { filters.push(`${table}.or=${expr}`); return b; };
      b.single = async () => {
        const rows = spec.rows ?? [];
        return rows.length ? { data: rows[0], error: null } : { data: null, error: { code: 'PGRST116' } };
      };
      b.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
        if (spec.error) return reject ? reject(spec.error) : resolve({ data: null, error: spec.error, count: null });
        return resolve({ data: spec.rows ?? [], error: null, count: spec.count ?? (spec.rows ?? []).length });
      };
      return b;
    },
  };
}

const AGENT_ROW = {
  chain: 'celo',
  agent_id: 1870,
  owner: OWNER,
  agent_wallet: OWNER,
  token_uri: 'https://api.toppa.cc/registration.json',
  registration: {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'Toppa',
    services: [{ name: 'send-airtime', endpoint: 'https://api.toppa.cc/send-airtime' }],
  },
  registration_status: 'fetched',
  metadata_score: 90,
  feedback_count: 2,
  feedback_avg: '100',
};

const FEEDBACK_ROWS = [
  { agent_id: 1870, client: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', feedback_index: 1, value: '100', value_decimals: 0, tag1: 'airtime', tag2: 'success', revoked: false, indexed_at: '2026-08-30T10:00:00.000Z' },
  { agent_id: 1870, client: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', feedback_index: 1, value: '100', value_decimals: 0, tag1: 'data', tag2: 'success', revoked: false, indexed_at: '2026-08-29T10:00:00.000Z' },
];

const WALLET_ROW = {
  chain: 'celo',
  address: OWNER,
  provider_score: 100,
  consumer_score: null,
  trust_tier: 'Excellent',
  confidence_badge: 'declared',
  claimed: false,
  celo_agent_id: 1870,
  rank_score: 70,
  tx_count: 0,
} as unknown as Wallet;

const CORE = {
  provider: { score: 100, trustTier: 'Excellent', confidenceBadge: 'declared' as const },
  consumerHasSignal: false,
  txCount: 0,
  claimed: false,
};

afterEach(() => __setSupabaseForTest(null));

describe('resolveKarmaEnrichment', () => {
  test('happy path: every block present, rankScore from the row, explain derived', async () => {
    const calls: string[] = [];
    __setSupabaseForTest(makeFakeSupabase({
      erc8004_agents: { rows: [AGENT_ROW], count: 1 },
      erc8004_feedback: { rows: FEEDBACK_ROWS },
      celo_x402_payees: { rows: [] },
    }, calls));

    const e = await resolveKarmaEnrichment({ address: OWNER, chain: 'celo', walletRow: WALLET_ROW, core: CORE });

    expect(e.registry?.total).toBe(1);
    expect(e.registry?.agents[0]).toMatchObject({ agentId: 1870, name: 'Toppa' });
    expect(e.declared?.agentId).toBe(1870);
    expect(e.declared?.version).toBe('v0.2');
    expect(e.feedback).toMatchObject({ source: 'registry-mirror', count: 2, average: 100, distinctClients: 2, sampled: 2 });
    expect(e.discovery).toBeUndefined();
    expect(e.rankScore).toBe(70);
    expect(e.explain[0]).toStartWith('Provider score 100 (Excellent), declared;');
    expect(e.explain).toContain('Owns 1 ERC-8004 agent on celo: "Toppa".');
    expect(e.explain).toContain('Ranks on Explore at 70 (declared evidence is weighted ×0.7).');
    // Read-only: exactly the three enrichment tables, nothing else, no fetches.
    expect(new Set(calls)).toEqual(new Set(['erc8004_agents', 'erc8004_feedback', 'celo_x402_payees']));
  });

  test('feedback table throws → feedback omitted, registry/declared/rankScore/explain still ship', async () => {
    __setSupabaseForTest(makeFakeSupabase({
      erc8004_agents: { rows: [AGENT_ROW], count: 1 },
      erc8004_feedback: { error: { message: 'canceling statement due to statement timeout' } },
      celo_x402_payees: { rows: [] },
    }));

    const e = await resolveKarmaEnrichment({ address: OWNER, chain: 'celo', walletRow: WALLET_ROW, core: CORE });

    expect(e.feedback).toBeUndefined();
    expect(e.registry?.total).toBe(1);
    expect(e.declared?.score).toBeGreaterThan(0);
    expect(e.rankScore).toBe(70);
    expect(e.explain.some((l) => l.includes('feedback'))).toBe(false);
    expect(e.explain).toContain('Owns 1 ERC-8004 agent on celo: "Toppa".');
  });

  test('registry table throws → registry, declared AND feedback omitted; no "no identity" claim', async () => {
    __setSupabaseForTest(makeFakeSupabase({
      erc8004_agents: { error: { message: 'boom' } },
      celo_x402_payees: { rows: [] },
    }));

    const e = await resolveKarmaEnrichment({ address: OWNER, chain: 'celo', walletRow: WALLET_ROW, core: CORE });

    expect(e.registry).toBeUndefined();
    expect(e.declared).toBeUndefined();
    expect(e.feedback).toBeUndefined();
    expect(e.explain.some((l) => l.includes('No ERC-8004 registry identity'))).toBe(false);
    expect(e.rankScore).toBe(70);
  });

  test('no wallet row + nothing owned → rankScore null, explicit "no identity" line, no feedback block', async () => {
    __setSupabaseForTest(makeFakeSupabase({
      erc8004_agents: { rows: [], count: 0 },
      celo_x402_payees: { rows: [] },
    }));

    const e = await resolveKarmaEnrichment({
      address: '4VRzfgGq8VkUH8PFiwzD3dDYkGNijvA1MCkP6Zwn8eYn',
      chain: 'solana',
      walletRow: null,
      core: { ...CORE, provider: { score: 78, trustTier: 'Good', confidenceBadge: 'receipt-backed' }, txCount: 12, consumerHasSignal: true },
    });

    expect(e.registry).toBeUndefined();
    expect(e.feedback).toBeUndefined();
    expect(e.rankScore).toBeNull();
    expect(e.explain).toContain('No ERC-8004 registry identity found for this address on solana.');
  });

  test('checksummed EVM input is normalized at the boundary (rows are stored lowercase)', async () => {
    const filters: string[] = [];
    const CHECKSUMMED = '0x68961aC3376fa6c2aa20689307Be57f107031B31';
    __setSupabaseForTest(makeFakeSupabase({
      erc8004_agents: { rows: [], count: 0 },
      celo_x402_payees: { rows: [] },
    }, [], filters));

    await resolveKarmaEnrichment({ address: CHECKSUMMED, chain: 'celo', walletRow: null, core: CORE });

    const lower = CHECKSUMMED.toLowerCase();
    expect(filters).toContain(`erc8004_agents.or=owner.eq.${lower},agent_wallet.eq.${lower}`);
    expect(filters).toContain(`celo_x402_payees.address=${lower}`);
    expect(filters.some((f) => f.includes(CHECKSUMMED))).toBe(false);
  });

  test('unverified payee from another agent is surfaced but not attributed', async () => {
    __setSupabaseForTest(makeFakeSupabase({
      erc8004_agents: { rows: [], count: 0 },
      celo_x402_payees: { rows: [{
        chain: 'celo', address: OWNER, source_agent_id: 42, endpoint: 'https://other.example/pay', asset: null,
        network: 'eip155:42220', verified: false, discovered_at: '2026-08-01T00:00:00.000Z', last_seen_at: '2026-08-02T00:00:00.000Z',
      }] },
    }));

    const e = await resolveKarmaEnrichment({ address: OWNER, chain: 'celo', walletRow: WALLET_ROW, core: CORE });

    expect(e.discovery?.endpoints[0]).toMatchObject({ verified: false, sourceAgentId: 42 });
    expect(e.explain).toContain('1 unverified x402 payee declaration points at this address from another agent (not attributed to this wallet).');
  });
});

describe('resolveKarma boundary normalization', () => {
  test('checksummed EVM input reads the lowercase wallets row', async () => {
    const filters: string[] = [];
    const CHECKSUMMED = '0x68961aC3376fa6c2aa20689307Be57f107031B31';
    const lower = CHECKSUMMED.toLowerCase();
    __setSupabaseForTest(makeFakeSupabase({
      wallets: { rows: [{ ...WALLET_ROW, address: lower, celo_agent_id: null }] },
      erc8004_agents: { rows: [], count: 0 },
    }, [], filters));

    const snap = await resolveKarma(CHECKSUMMED);

    expect(snap?.address).toBe(lower);
    expect(filters).toContain(`wallets.address=${lower}`);
    expect(filters.some((f) => f.includes(CHECKSUMMED))).toBe(false);
  });
});
