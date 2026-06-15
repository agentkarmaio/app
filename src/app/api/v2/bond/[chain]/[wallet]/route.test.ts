/// <reference types="bun-types" />
/**
 * Route tests for GET /api/v2/bond/[chain]/[wallet] — chain/address guard +
 * a DB-backed happy path (via __setSupabaseForTest) asserting demo flagging
 * and the orthogonal surety block.
 *
 * Run: bun test "src/app/api/v2/bond/[chain]/[wallet]/route.test.ts"
 */
import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { __setSupabaseForTest } from '@/db/client';

const SOLANA = '3rGu9hPHdgwR8KeZTpPkN4Z5VRBeR3LBs9CAnqJ7yDjZ';

function req(): NextRequest {
  return new NextRequest('http://localhost/api/v2/bond/x/y');
}
const params = (chain: string, wallet: string) =>
  ({ params: Promise.resolve({ chain, wallet }) });

/**
 * Fake supabase routing per-table: `bonds` returns bond rows (await on order),
 * `bond_underwriters` returns underwriter rows (joined bonds(*)).
 */
function makeFake(bonds: unknown[], underwriters: unknown[]) {
  return {
    from(table: string) {
      const rows = table === 'bonds' ? bonds : underwriters;
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.order = () => builder;
      builder.then = (resolve: (v: { data: unknown[]; error: null }) => void) =>
        resolve({ data: rows, error: null });
      return builder;
    },
  };
}

describe('GET /api/v2/bond/[chain]/[wallet] guard', () => {
  test('unknown chain → 400', async () => {
    const res = await GET(req(), params('bitcoin', SOLANA));
    expect(res.status).toBe(400);
  });

  test('chain/address mismatch (stellar chain on a Solana address) → 400', async () => {
    const res = await GET(req(), params('stellar', SOLANA));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/v2/bond/[chain]/[wallet] happy path', () => {
  test('demo bond is flagged; surety block present + orthogonal', async () => {
    __setSupabaseForTest(makeFake(
      [
        {
          id: 'b1', chain: 'solana', bonded_agent_wallet: SOLANA, beneficiary: 'BEN',
          task_ref: null, amount: 100, currency: 'USDC', status: 'open',
          escrow_ref: 'e1', resolution_proof_tx: null, is_demo: true,
          opened_at: '2026-06-10T00:00:00Z', resolved_at: null,
        },
      ],
      [
        {
          id: 'u1', bond_id: 'b9', chain: 'solana', underwriter_wallet: SOLANA,
          stake_amount: 50, premium_earned: null, settled: true,
          created_at: '2026-06-09T00:00:00Z',
          bonds: { id: 'b9', status: 'resolved_success', amount: 50, currency: 'USDC' },
        },
      ],
    ));

    const res = await GET(req(), params('solana', SOLANA));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bonds.open).toHaveLength(1);
    expect(body.bonds.open[0].isDemo).toBe(true);
    expect(body.bonds.hasDemo).toBe(true);
    expect(body.bonds.totalBondedUsdc).toBe(100);
    // Surety is its own top-level block — never merged into a bond/score field.
    expect(body.surety).not.toBeNull();
    expect(body.surety.settledCount).toBe(1);
    expect(body.surety.successCount).toBe(1);
  });

  test('no underwriting → surety null', async () => {
    __setSupabaseForTest(makeFake([], []));
    const res = await GET(req(), params('solana', SOLANA));
    const body = await res.json();
    expect(body.surety).toBeNull();
    expect(body.bonds.open).toHaveLength(0);
    expect(body.bonds.hasDemo).toBe(false);
  });
});
