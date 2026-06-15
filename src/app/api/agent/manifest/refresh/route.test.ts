/// <reference types="bun-types" />
/**
 * Route tests for POST /api/agent/manifest/refresh — chain-dispatched guard.
 *
 * Run: bun test src/app/api/agent/manifest/refresh/route.test.ts
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { __resetRateLimitForTests } from '@/lib/rate-limit';

const STELLAR = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

// The 404 case touches getWallet (DB). Only run it when Supabase env is wired;
// the two 400 guards run BEFORE any DB access and are unconditional.
const DB_READY = !!process.env.NEXT_PUBLIC_SUPABASE_URL;

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/agent/manifest/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/agent/manifest/refresh guard', () => {
  // Clear the shared in-memory rate-limit budget before each case so prior
  // tests (here or in other files) can't push this endpoint's IP over the cap.
  beforeEach(() => __resetRateLimitForTests());

  test('missing wallet → 400 Missing wallet', async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Missing wallet');
  });

  test('junk wallet → 400 Invalid wallet address', async () => {
    const res = await POST(makeReq({ wallet: 'not-a-wallet' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid wallet address');
  });

  // No-DB strong RED: the OLD `new PublicKey(wallet)` guard 400s a Stellar
  // G-address before any DB call. The NEW chain-dispatched guard must let it
  // PAST the guard. Without a DB the downstream getWallet throws — that thrown
  // error still proves we cleared the guard (no 400 was returned).
  test('valid Stellar G-address is not rejected at the guard (no 400)', async () => {
    let res: Response | null = null;
    try {
      res = await POST(makeReq({ wallet: STELLAR }));
    } catch {
      // Reaching the DB layer (and throwing there) means the guard passed.
      return;
    }
    expect(res.status).not.toBe(400);
  });

  test.if(DB_READY)('valid Stellar G-address passes guard → 404 unknown wallet', async () => {
    const res = await POST(makeReq({ wallet: STELLAR }));
    expect(res.status).toBe(404); // getWallet returns null → "Wallet not found"
  });
});
