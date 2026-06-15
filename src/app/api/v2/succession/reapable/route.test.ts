/// <reference types="bun-types" />
/**
 * Route tests for GET /api/v2/succession/reapable — pure param validation
 * (chain + status subset guards run before any DB access).
 *
 * The DB-backed happy path is exercised via __setSupabaseForTest so it runs
 * without a live connection.
 *
 * Run: bun test "src/app/api/v2/succession/reapable/route.test.ts"
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { __setSupabaseForTest } from '@/db/client';

function makeFake(rows: unknown[], count = rows.length) {
  return {
    from() {
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.in = () => builder;
      builder.order = () => builder;
      builder.range = async () => ({ data: rows, error: null, count });
      return builder;
    },
  };
}

function req(search = ''): NextRequest {
  return new NextRequest(`http://localhost/api/v2/succession/reapable${search}`);
}

describe('GET /api/v2/succession/reapable guards', () => {
  test('unknown chain → 400', async () => {
    const res = await GET(req('?chain=bitcoin'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Unknown chain');
  });

  test('status outside the reapable set → 400', async () => {
    const res = await GET(req('?status=live'));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/v2/succession/reapable happy path', () => {
  beforeEach(() => {
    __setSupabaseForTest(makeFake([
      {
        chain: 'solana', agent_wallet: 'A', status: 'lapsed', interval_seconds: 86400,
        heirs: [{ address: 'H', chain: 'solana' }], last_heartbeat_at: '2026-06-01T00:00:00Z',
        lapsed_at: '2026-06-05T00:00:00Z', executed_at: null, declared_at: '2026-05-01T00:00:00Z',
      },
    ], 1));
  });

  test('returns estates with default statuses + pagination echo', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.limit).toBe(25);
    expect(body.offset).toBe(0);
    expect(body.statuses).toEqual(['lapsing', 'lapsed', 'executed']);
    expect(body.estates).toHaveLength(1);
    expect(body.estates[0].address).toBe('A');
    expect(body.estates[0].heirCount).toBe(1);
  });

  test('limit is clamped to [1,100]', async () => {
    const res = await GET(req('?limit=9999'));
    expect((await res.json()).limit).toBe(100);
  });

  test('valid status subset is honored + echoed', async () => {
    const res = await GET(req('?status=lapsed'));
    const body = await res.json();
    expect(body.statuses).toEqual(['lapsed']);
  });
});
