/// <reference types="bun-types" />
/**
 * GET /api/v2/score/{wallet} — chain pinning.
 *
 * An EVM address can hold rows on BOTH celo and arc (same key format). Without
 * a pin the route had to guess (detectChain → null → rows[0]), which returned a
 * well-formed snapshot for an arbitrary chain. `?chain=` pins the lookup; a pin
 * that mismatches the address format is a 400, never a silent downgrade.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { __setSupabaseForTest } from '@/db/client';
import { GET, pickWalletRow } from './route';

const EVM = '0xcfc0a11c75519faf85b7872e27733cfaa4295b96';
const SOL = '4VRzfgGq8VkUH8PFiwzD3dDYkGNijvA1MCkP6Zwn8eYn';
const row = (chain: string) => ({ chain, address: EVM }) as never;

describe('pickWalletRow', () => {
  test('pinned chain wins over row order', () => {
    expect(pickWalletRow([row('celo'), row('arc')], EVM, 'arc')?.chain).toBe('arc');
  });
  test('pinned chain with no matching row → null (no fallback to another chain)', () => {
    expect(pickWalletRow([row('celo')], EVM, 'arc')).toBeNull();
  });
  test('unpinned single row is returned', () => {
    expect(pickWalletRow([row('celo')], EVM, null)?.chain).toBe('celo');
  });
  test('unpinned, format-detectable address prefers the detected chain', () => {
    const rows = [{ chain: 'celo', address: SOL }, { chain: 'solana', address: SOL }] as never[];
    expect(pickWalletRow(rows, SOL, null)?.chain).toBe('solana');
  });
});

describe('GET ?chain= validation', () => {
  const get = (url: string, wallet: string) =>
    GET(new Request(url) as never, { params: Promise.resolve({ wallet }) });

  test('unknown chain → 400', async () => {
    const res = await get(`http://x/api/v2/score/${EVM}?chain=polygon`, EVM);
    expect(res.status).toBe(400);
  });
  test('chain that mismatches the address format → 400', async () => {
    const res = await get(`http://x/api/v2/score/${SOL}?chain=celo`, SOL);
    expect(res.status).toBe(400);
  });
});

// ── Boundary normalization ───────────────────────────────────────────────────
// EVM rows are stored lowercase; a checksummed input used to 404 while the
// lowercase form 200'd (hit live by a partner bot). The route must canonicalize
// before any lookup. Fake Supabase: the wallets row exists ONLY under the
// lowercase key; every other table is empty.
describe('GET canonicalizes a checksummed EVM wallet', () => {
  afterEach(() => __setSupabaseForTest(null));

  const CHECKSUMMED = '0x68961aC3376fa6c2aa20689307Be57f107031B31';
  const LOWER = CHECKSUMMED.toLowerCase();
  const ROW = {
    chain: 'celo', address: LOWER, provider_score: 88, consumer_score: null, trust_tier: 'Very Good',
    confidence_badge: 'declared', claimed: false, celo_agent_id: null, rank_score: 61.6, tx_count: 0,
    last_seen: '2026-06-11T13:02:40.71+00:00', updated_at: '2026-06-11T13:02:40.71+00:00',
  };

  function fakeSupabase(filters: string[]) {
    return {
      from(table: string) {
        const b: Record<string, unknown> = {};
        let addressArg: string | null = null;
        for (const m of ['select', 'in', 'or', 'order', 'limit', 'gte', 'lte', 'is', 'not', 'range']) b[m] = () => b;
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
      rpc: () => ({ then: (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: 'no rpc in test' } }) }),
    };
  }

  test('checksummed input → 200 with the lowercase row; no lookup ever uses the checksummed form', async () => {
    const filters: string[] = [];
    __setSupabaseForTest(fakeSupabase(filters));
    const res = await GET(
      new Request(`http://x/api/v2/score/${CHECKSUMMED}?chain=celo`) as never,
      { params: Promise.resolve({ wallet: CHECKSUMMED }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { address: string; chain: string; provider: { score: number }; explain: string[]; rankScore: number | null };
    expect(body.address).toBe(LOWER);
    expect(body.chain).toBe('celo');
    expect(body.provider.score).toBe(88);
    expect(body.rankScore).toBe(61.6);
    expect(Array.isArray(body.explain)).toBe(true);
    expect(filters.some((f) => f.includes(CHECKSUMMED))).toBe(false);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
  }, 20_000);
});
