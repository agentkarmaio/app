/// <reference types="bun-types" />
/**
 * Route tests for GET /api/v2/succession/[chain]/[wallet] — chain/address
 * guard, 404 when no will, and a DB-backed happy path asserting the derived
 * liveness + heir count.
 *
 * Run: bun test "src/app/api/v2/succession/[chain]/[wallet]/route.test.ts"
 */
import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { __setSupabaseForTest } from '@/db/client';

const SOLANA = '3rGu9hPHdgwR8KeZTpPkN4Z5VRBeR3LBs9CAnqJ7yDjZ';

function req(): NextRequest {
  return new NextRequest('http://localhost/api/v2/succession/x/y');
}
const params = (chain: string, wallet: string) =>
  ({ params: Promise.resolve({ chain, wallet }) });

function makeFake(succession: unknown, txs: unknown[]) {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.order = () => builder;
      builder.limit = async () => ({ data: txs, error: null });
      builder.maybeSingle = async () => ({ data: succession, error: null });
      // getRecentTransactionsForWallet ends on .limit(); successions on .maybeSingle().
      void table;
      return builder;
    },
  };
}

describe('GET /api/v2/succession/[chain]/[wallet] guard', () => {
  test('unknown chain → 400', async () => {
    const res = await GET(req(), params('bitcoin', SOLANA));
    expect(res.status).toBe(400);
  });

  test('stellar chain on a Solana address → 400', async () => {
    const res = await GET(req(), params('stellar', SOLANA));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/v2/succession/[chain]/[wallet] behavior', () => {
  test('no declared will → 404', async () => {
    __setSupabaseForTest(makeFake(null, []));
    const res = await GET(req(), params('solana', SOLANA));
    expect(res.status).toBe(404);
  });

  test('declared will + recent tx → 200 with derived live status', async () => {
    __setSupabaseForTest(makeFake(
      {
        chain: 'solana', agent_wallet: SOLANA, source_type: 'claim_form',
        interval_seconds: 86_400 * 3650, // huge interval → always live
        heirs: [{ address: 'H1', chain: 'solana' }, { address: 'H2', chain: 'solana' }],
        status: 'declared', will_hash: null, declared_at: '2026-06-01T00:00:00Z',
        last_heartbeat_at: null, lapsed_at: null, executed_at: null,
        revoked_at: null, updated_at: '2026-06-01T00:00:00Z',
      },
      [{ timestamp: '2026-06-14T00:00:00Z' }],
    ));
    const res = await GET(req(), params('solana', SOLANA));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.address).toBe(SOLANA);
    expect(body.succession.status).toBe('live');
    expect(body.succession.heirCount).toBe(2);
    expect(body.succession.lastHeartbeatAt).toBe('2026-06-14T00:00:00.000Z');
  });
});
