/// <reference types="bun-types" />
/**
 * GET /api/badge/[wallet] — chain resolution.
 *
 * Regression: the badge endpoint assumed Solana (getWallet defaults to the
 * Solana row). Any agent on Celo/Arc/Stellar — including the #1 leaderboard
 * agent that the /widget Live Preview samples — 404'd, rendering a broken
 * image. The badge MUST resolve the agent's actual chain (same resolver the
 * /agent page uses) and render the stored score for chains without indexed
 * receipts. Driven by a table-aware fake Supabase.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { __setSupabaseForTest } from '@/db/client';
import { GET } from './route';

// A 0x…40hex address classifies as EVM → resolves via any-chain wallet lookup.
const ARC_ADDR = '0xde65df7ab93a88aa48e6e1d847d718b05721a1bc';

const arcRow = {
  chain: 'arc',
  address: ARC_ADDR,
  score: 100,
  provider_score: 100,
  consumer_score: null,
  trust_tier: 'Excellent',
  confidence_badge: 'declared',
  display_name: 'Faye — Chief of Staff Agent',
  autonomy_score: null,
  autonomy_label: null,
  tx_count: 0,
  last_seen: '2026-06-11T15:17:22.927+00:00',
};

// Wallet row lives ONLY on Arc: a Solana-scoped getWallet returns PGRST116, the
// any-chain lookup (eq('address') with no chain) returns [arcRow], transactions
// are empty. Mirrors the broken-preview agent exactly.
function makeBadgeFake() {
  return {
    from(table: string) {
      const eqs: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'order', 'in', 'gt', 'gte', 'lt', 'not', 'limit']) b[m] = () => b;
      b.eq = (col: string, val: unknown) => { eqs[col] = val; return b; };
      b.range = async () => ({ data: [], error: null });
      b.single = async () =>
        table === 'wallets' && eqs.chain === 'arc' && eqs.address === ARC_ADDR
          ? { data: arcRow, error: null }
          : { data: null, error: { code: 'PGRST116' } };
      b.maybeSingle = async () => ({ data: null, error: null });
      // getWalletsByAddressAnyChain awaits the builder directly (no .single()).
      b.then = (resolve: (v: { data: unknown[]; error: null }) => void) =>
        resolve({
          data: table === 'wallets' && eqs.address === ARC_ADDR ? [arcRow] : [],
          error: null,
        });
      return b;
    },
  };
}

function req(query = '?format=svg'): Request {
  return new Request(`http://localhost/api/badge/${ARC_ADDR}${query}`);
}

afterEach(() => { __setSupabaseForTest(null); });

describe('GET /api/badge/[wallet] resolves non-Solana chains', () => {
  test('renders a 200 SVG for an agent that exists only on Arc', async () => {
    __setSupabaseForTest(makeBadgeFake());
    const res = await GET(req() as never, { params: Promise.resolve({ wallet: ARC_ADDR }) });
    expect(res.status).toBe(200); // pre-fix: 404 (looked up on Solana, not found)
    expect(res.headers.get('content-type')).toContain('image/svg');
    const body = await res.text();
    expect(body).toContain('100.0'); // stored Arc score, not a Solana live recompute
  });

  test('JSON format returns the resolved agent, not 404', async () => {
    __setSupabaseForTest(makeBadgeFake());
    const res = await GET(req('?format=json') as never, { params: Promise.resolve({ wallet: ARC_ADDR }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.trustTier).toBe('Excellent');
    expect(json.score).toBe(100);
  });
});
