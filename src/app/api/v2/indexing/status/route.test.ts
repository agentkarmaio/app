import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { __setSupabaseForTest } from '@/db/client';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET, OPTIONS } from './route';

function database(data: unknown[], error: unknown = null) {
  const query = {
    select: () => query,
    order: () => query,
    then: (resolve: (value: { data: unknown[]; error: unknown }) => unknown) => Promise.resolve(resolve({ data, error })),
  };
  return { from: () => query };
}
const request = () => new NextRequest('http://localhost/api/v2/indexing/status', { headers: { 'x-forwarded-for': '192.0.2.194' } });

beforeEach(() => __resetRateLimitForTests());
afterEach(() => __setSupabaseForTest(null));

describe('GET indexing status', () => {
  test('returns four chains with unknown coverage when no worker has run', async () => {
    __setSupabaseForTest(database([]));
    const response = await GET(request());
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(result.chains.map((chain: { chain: string }) => chain.chain)).toEqual(['solana', 'arc', 'celo', 'stellar']);
    expect(result.status).toBe('unknown');
    expect(result.chains[0].paths[0].lastSuccessAt).toBeNull();
  });

  test('database failure is a safe uncached 503, never invented healthy state', async () => {
    __setSupabaseForTest(database([], { message: 'SECRET https://provider.invalid/?key=secret' }));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'indexing_status_unavailable' });
  });

  test('projection never exposes lease owners or raw provider errors', async () => {
    __setSupabaseForTest(database([{
      chain: 'arc', path: 'escrow', enabled: true, status: 'failed', owner: null,
      last_attempt_at: null, last_finished_at: null, last_success_at: null,
      interval_ms: 300000, lease_until: null, error_code: 'TOPSECRET',
      checkpoint: 'PRIVATE', head: 'PRIVATE', checked_count: 0, pending_count: 4,
      inserted_count: 0, unresolved_count: 1, generation: 7,
    }]));
    const result = await (await GET(request())).text();
    expect(result).not.toContain('TOPSECRET');
    expect(result).not.toContain('PRIVATE');
    expect(result).not.toContain('generation');
    expect(result).toContain('failed');
  });

  test('rate-limited requests retain CORS and are never cached', async () => {
    __setSupabaseForTest(database([]));
    let response: Response | undefined;
    for (let i = 0; i <= 60; i++) response = await GET(request());
    expect(response!.status).toBe(429);
    expect(response!.headers.get('Cache-Control')).toBe('no-store');
    expect(response!.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  test('preflight supports the public read endpoint', async () => {
    const response = await OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
