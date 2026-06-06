/// <reference types="bun-types" />
/**
 * Route tests for GET /api/score/[wallet] — chain-dispatched address guard.
 *
 * Run: bun test "src/app/api/score/[wallet]/route.test.ts"
 */

import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { GET } from './route';

const STELLAR = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const SOLANA = '3rGu9hPHdgwR8KeZTpPkN4Z5VRBeR3LBs9CAnqJ7yDjZ';

// The non-400 assertions reach rate-limit + DB; only run them when the
// Supabase env is wired (CI without a DB still exercises the pure 400 guards,
// which run BEFORE any external service).
const DB_READY = !!process.env.NEXT_PUBLIC_SUPABASE_URL;

function makeReq(wallet: string, search = ''): NextRequest {
  return new NextRequest(`http://localhost/api/score/${wallet}${search}`);
}
const params = (wallet: string) => ({ params: Promise.resolve({ wallet }) });

describe('GET /api/score/[wallet] guard', () => {
  test('junk address → 400 Invalid wallet address', async () => {
    const res = await GET(makeReq('not-a-wallet'), params('not-a-wallet'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid wallet address');
  });

  test('?chain mismatch (stellar param on a Solana address) → 400', async () => {
    const res = await GET(makeReq(SOLANA, '?chain=stellar'), params(SOLANA));
    expect(res.status).toBe(400);
  });

  test.if(DB_READY)('valid Stellar G-address passes the guard (not 400)', async () => {
    const res = await GET(makeReq(STELLAR), params(STELLAR));
    // Unknown wallet → 202 (scan enqueue) or 200 (stub row); the guard must NOT 400.
    expect(res.status).not.toBe(400);
  });
});
