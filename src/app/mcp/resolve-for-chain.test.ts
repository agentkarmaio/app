/// <reference types="bun-types" />
/**
 * resolveForChain — the shared MCP `get_karma` / A2A entry point. A checksummed
 * EVM address must canonicalize BEFORE the (chain,address) row lookup, and the
 * enrichment blocks must ride along on the resolved union. Fake Supabase; the
 * wallets row exists only under the lowercase key and carries no agentId, so
 * no chain RPC is attempted.
 */
import { afterEach, describe, expect, test, spyOn } from 'bun:test';
import { __setSupabaseForTest } from '@/db/client';
import { resolveForChain, fullKarmaJson } from './route';
import { getAdapter } from '@/chain-adapters/registry';
import { resolveKarma } from '@/lib/karma-resolver';
import { AK_STELLAR } from '@/config/ak-validator';

const CHECKSUMMED = '0x68961aC3376fa6c2aa20689307Be57f107031B31';
const LOWER = CHECKSUMMED.toLowerCase();
const ROW = {
  chain: 'celo', address: LOWER, provider_score: 88, consumer_score: null, trust_tier: 'Very Good',
  confidence_badge: 'declared', claimed: false, celo_agent_id: null, arc_agent_id: null, rank_score: 61.6, tx_count: 0,
};

function fakeSupabase(filters: string[]) {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      let addressArg: string | null = null;
      for (const m of ['select', 'in', 'or', 'order', 'limit']) b[m] = () => b;
      b.eq = (col: string, v: unknown) => {
        filters.push(`${table}.${col}=${String(v)}`);
        if (col === 'address') addressArg = String(v);
        return b;
      };
      const rowsFor = () => (table === 'wallets' && addressArg === LOWER ? [ROW] : []);
      b.single = async () => {
        const rows = rowsFor();
        return rows.length ? { data: rows[0], error: null } : { data: null, error: { code: 'PGRST116' } };
      };
      b.maybeSingle = async () => ({ data: rowsFor()[0] ?? null, error: null });
      b.then = (resolve: (v: unknown) => void) => resolve({ data: rowsFor(), error: null, count: rowsFor().length });
      return b;
    },
  };
}

afterEach(() => __setSupabaseForTest(null));

function stellarStore(filters: string[], transactions: Record<string, unknown>[] = []) {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      let chain: unknown;
      let address: unknown;
      for (const method of ['select', 'in', 'or', 'order', 'limit', 'range', 'gte', 'lte']) b[method] = () => b;
      b.eq = (key: string, value: unknown) => {
        filters.push(`${table}.${key}=${value}`);
        if (key === 'chain') chain = value;
        if (key === 'address') address = value;
        return b;
      };
      const rows = () => table === 'transactions' ? transactions : table === 'wallets' && chain === 'stellar' && address === AK_STELLAR.account
        ? [{ ...ROW, address, chain, provider_score: 90, consumer_score: null, trust_tier: 'Excellent', stellar_agent_id: 66 }]
        : [];
      b.single = b.maybeSingle = async () => ({ data: rows()[0] ?? null, error: rows().length ? null : { code: 'PGRST116' } });
      b.then = (resolve: (data: unknown) => void) => resolve({ data: rows(), error: null, count: rows().length });
      return b;
    },
  };
}

describe('Stellar output acceptance', () => {
  test('an own published Stellar score cannot promote transaction behavior to receipt-backed confidence', async () => {
    __setSupabaseForTest(stellarStore([], [{
      id: 'stellar-receipt', chain: 'stellar', wallet_address: AK_STELLAR.account,
      facilitator: 'stellar-channel', counterparty: 'stellar-provider', amount: '0.001',
      success: true, timestamp: new Date().toISOString(), tx_signature: 'stellar-receipt',
    }]));
    const read = spyOn(getAdapter('stellar'), 'readAttestation').mockResolvedValue(75);
    try {
      const result = await resolveForChain(AK_STELLAR.account, 'stellar');
      expect(result?.kind).toBe('stellar');
      if (result?.kind !== 'stellar') throw new Error('Expected the Stellar snapshot');
      expect(result.onChainAttestation).toBe(75);
      expect(result.snap.provider.metrics?.attestation).toBe(0);
      expect(result.snap.provider.confidenceBadge).toBe('behavior-inferred');
      expect(result.snap.txCount).toBe(1);
    } finally { read.mockRestore(); }
  });
  test('returns the registered Stellar wallet score and keeps the missing consumer unrated', async () => {
    const filters: string[] = [];
    __setSupabaseForTest(stellarStore(filters));
    const read = spyOn(getAdapter('stellar'), 'readAttestation').mockResolvedValue(0);
    try {
      const result = await resolveForChain(AK_STELLAR.account, 'stellar');
      expect(result?.kind).toBe('stellar');
      const json = fullKarmaJson(result!, AK_STELLAR.account);
      expect(json).toMatchObject({ chain: 'stellar', provider: { score: 90, confidenceBadge: 'declared' }, consumer: { score: null, trustTier: 'Unrated' } });
      expect(filters).not.toContain('wallets.chain=solana');
      expect(read).toHaveBeenCalledTimes(1);
    } finally { read.mockRestore(); }
  });
  test('direct snapshot callers also infer the format-unique Stellar chain', async () => {
    const filters: string[] = [];
    __setSupabaseForTest(stellarStore(filters));
    const read = spyOn(getAdapter('stellar'), 'readAttestation').mockResolvedValue(75);
    try {
      const snapshot = await resolveKarma(AK_STELLAR.account);
      expect(snapshot?.provider.score).toBe(90);
      expect(snapshot?.consumer.hasSignal).toBe(false);
      expect(filters).toContain('wallets.chain=stellar');
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });
});

describe('resolveForChain boundary normalization', () => {
  test('an explicit Arc request never uses the only matching Celo row', async () => {
    __setSupabaseForTest(fakeSupabase([]));
    expect(await resolveForChain(CHECKSUMMED, 'arc')).toBeNull();
  });
  test('checksummed EVM + chain hint resolves the lowercase celo row and carries enrichment', async () => {
    const filters: string[] = [];
    __setSupabaseForTest(fakeSupabase(filters));

    const resolved = await resolveForChain(CHECKSUMMED, 'celo');
    expect(resolved?.kind).toBe('evm');
    expect(filters.some((f) => f.includes(CHECKSUMMED))).toBe(false);

    const json = fullKarmaJson(resolved!, LOWER) as Record<string, unknown>;
    expect(json.chain).toBe('celo');
    expect(json.address).toBe(LOWER);
    expect(json.rankScore).toBe(61.6);
    expect(Array.isArray(json.explain)).toBe(true);
    // Two faces + badge untouched by the additive blocks.
    expect((json.provider as { score: number }).score).toBe(88);
    expect((json.consumer as { score: null }).score).toBeNull();
    expect(json.confidenceBadge).toBe('declared');
  }, 20_000);
});
