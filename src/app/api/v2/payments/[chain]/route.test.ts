/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as db from '@/db/client';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET } from './route';

const G = 'GC2NIKT6TWLMBZE4TU5ZMMDVV22URFIMJIZ4JYUC3QABBBWNGGZMAFGM';
let feed: ReturnType<typeof spyOn<typeof db, 'getPaymentFeed'>>;
beforeEach(() => {
  feed = spyOn(db, 'getPaymentFeed').mockResolvedValue({
    payments: [{ id: '900:0', txHash: 'h1', from: 'GPAYER', to: G, amount: '0.0010000', timestamp: '2026-10-14T00:00:00+00:00', success: true }],
    cursor: 'next',
    done: true,
  });
});
afterEach(() => { feed.mockRestore(); __resetRateLimitForTests(); });

const get = (chain: string, qs = '') =>
  GET(new Request(`http://x/api/v2/payments/${chain}${qs}`) as never, { params: Promise.resolve({ chain }) });

describe('GET /api/v2/payments/[chain]', () => {
  test('returns the documented shape, uncached', async () => {
    const res = await get('stellar-testnet');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({
      chain: 'stellar-testnet', network: 'testnet',
      asset: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        sac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA', decimals: 7 },
      payments: [{ id: '900:0', txHash: 'h1', from: 'GPAYER', to: G, amount: '0.0010000', timestamp: '2026-10-14T00:00:00+00:00', success: true }],
      cursor: 'next',
      done: true,
    });
    expect(feed).toHaveBeenCalledWith('stellar-testnet', { limit: 500, cursor: null });
  });

  test('limit is clamped to 1..1000 and a valid cursor is decoded', async () => {
    const c = { timestamp: '2026-10-14T00:00:00+00:00', id: '00000000-0000-0000-0000-000000000001' };
    await get('stellar-testnet', `?limit=5000&cursor=${db.encodePaymentsCursor(c)}`);
    expect(feed).toHaveBeenLastCalledWith('stellar-testnet', { limit: 1000, cursor: c });
    await get('stellar-testnet', '?limit=0');
    expect(feed).toHaveBeenLastCalledWith('stellar-testnet', { limit: 1, cursor: null });
  });

  test('an invalid cursor is a 400 and a public chain a 404, without a read', async () => {
    expect((await get('stellar-testnet', '?cursor=bm9wZQ')).status).toBe(400);
    expect((await get('stellar')).status).toBe(404);
    expect((await get('solana')).status).toBe(404);
    expect(feed).not.toHaveBeenCalled();
  });
});
