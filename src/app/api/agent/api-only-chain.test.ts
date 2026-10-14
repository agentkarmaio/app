/// <reference types="bun-types" />
/**
 * stellar-testnet is API-only and read-only: write/ops routes refuse it before
 * any wallet or network access, and an unpinned manifest refresh never resolves
 * (or 409s on) a testnet row sharing a mainnet G-address.
 */
import { afterEach, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { POST as prove } from './prove/route';
import { POST as edit } from './edit/route';
import { POST as manifest } from './manifest/refresh/route';
import { POST as heartbeat } from '../cron/heartbeat/route';
import { POST as publish } from '../cron/publish/route';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { __setSupabaseForTest } from '@/db/client';
import { API_ONLY_CHAIN_ERROR } from '@/lib/api-only-chain';

const env = { cron: process.env.CRON_SECRET };
afterEach(() => {
  __setSupabaseForTest(null);
  __resetRateLimitForTests();
  if (env.cron === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = env.cron;
});

const G = 'GC2NIKT6TWLMBZE4TU5ZMMDVV22URFIMJIZ4JYUC3QABBBWNGGZMAFGM';

for (const [path, handler] of [
  ['agent/prove', prove], ['agent/edit', edit], ['agent/manifest/refresh', manifest],
  ['cron/heartbeat', heartbeat], ['cron/publish', publish],
] as const) {
  test(`${path} refuses stellar-testnet before wallet or network access`, async () => {
    process.env.CRON_SECRET = 'api-only-test';
    __setSupabaseForTest({ from() { throw new Error('Unexpected DB access'); } });
    const response = await handler(new NextRequest(`https://agentkarma.io/api/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer api-only-test' },
      body: JSON.stringify({ chain: 'stellar-testnet', address: G, wallet: G, displayName: 'x', signature: 's', message: 'm' }),
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: API_ONLY_CHAIN_ERROR });
  });
}

test('an unpinned manifest refresh ignores a same-address testnet row', async () => {
  __setSupabaseForTest({
    from() {
      const query = {
        select: () => query, eq: () => query, order: () => query,
        single: async () => ({ data: null, error: { code: 'PGRST116' } }),
        then: (resolve: (r: unknown) => void) => resolve({ data: [{ chain: 'stellar-testnet', address: G, website: 'https://x.example' }], error: null }),
      };
      return query;
    },
  });
  const response = await manifest(new NextRequest('https://agentkarma.io/api/agent/manifest/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: G }),
  }));
  expect(response.status).toBe(404);
});
