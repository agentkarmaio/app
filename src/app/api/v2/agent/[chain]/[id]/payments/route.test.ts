/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as db from '@/db/client';
import type { Wallet } from '@/db/schema';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET } from './route';

const G = 'GC2NIKT6TWLMBZE4TU5ZMMDVV22URFIMJIZ4JYUC3QABBBWNGGZMAFGM';
let agent: ReturnType<typeof spyOn<typeof db, 'getWalletByAgentId'>>;
let payments: ReturnType<typeof spyOn<typeof db, 'getReceivedPayments'>>;
beforeEach(() => {
  agent = spyOn(db, 'getWalletByAgentId').mockResolvedValue({ chain: 'stellar-testnet', address: G } as Wallet);
  payments = spyOn(db, 'getReceivedPayments').mockResolvedValue({
    payments: [{ id: '900:0', txHash: 'h1', from: 'GPAYER', amount: '0.0010000', timestamp: '2026-10-14T00:00:00+00:00', success: true, counted: true, excludedReason: null },
    { id: '901:0', txHash: 'h2', from: 'GOWNER', amount: '5.0000000', timestamp: '2026-10-13T00:00:00+00:00', success: true, counted: false, excludedReason: 'owner' }],
    nextCursor: 'abc',
  });
});
afterEach(() => { agent.mockRestore(); payments.mockRestore(); __resetRateLimitForTests(); });

const get = (chain: string, id: string, qs = '') =>
  GET(new Request(`http://x/api/v2/agent/${chain}/${id}/payments${qs}`) as never, { params: Promise.resolve({ chain, id }) });

describe('GET /api/v2/agent/[chain]/[id]/payments', () => {
  test('returns the documented shape for a stellar-testnet agent', async () => {
    const res = await get('stellar-testnet', '0');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({
      chain: 'stellar-testnet', network: 'testnet', agentId: 0, address: G,
      asset: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        sac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA', decimals: 7 },
      payments: [
        { id: '900:0', txHash: 'h1', from: 'GPAYER', amount: '0.0010000', timestamp: '2026-10-14T00:00:00+00:00', success: true, counted: true, excludedReason: null },
        { id: '901:0', txHash: 'h2', from: 'GOWNER', amount: '5.0000000', timestamp: '2026-10-13T00:00:00+00:00', success: true, counted: false, excludedReason: 'owner' },
      ],
      nextCursor: 'abc',
    });
    expect(agent).toHaveBeenCalledWith('stellar-testnet', 0);
    expect(payments).toHaveBeenCalledWith('stellar-testnet', 0, { limit: 50, cursor: null });
  });

  test('limit is clamped and a valid cursor is decoded', async () => {
    const cursor = db.encodePaymentsCursor({ timestamp: '2026-10-14T00:00:00+00:00', id: '00000000-0000-0000-0000-000000000001' });
    await get('stellar-testnet', '5', `?limit=999&cursor=${cursor}`);
    expect(payments).toHaveBeenCalledWith('stellar-testnet', 5, { limit: 200,
      cursor: { timestamp: '2026-10-14T00:00:00+00:00', id: '00000000-0000-0000-0000-000000000001' } });
  });

  test('a malformed cursor is a 400, never an unfiltered page', async () => {
    expect((await get('stellar-testnet', '5', '?cursor=garbage')).status).toBe(400);
    expect(payments).not.toHaveBeenCalled();
  });

  test('only API-only chains are served (mainnet payment ledgers are not exposed here)', async () => {
    for (const chain of ['stellar', 'celo', 'solana', 'bitcoin']) expect((await get(chain, '1')).status).toBe(404);
    expect(payments).not.toHaveBeenCalled();
  });

  test('bad ids 400, unknown agents 404', async () => {
    for (const id of ['-1', '1.5', 'x', '2147483648']) expect((await get('stellar-testnet', id)).status).toBe(400);
    agent.mockResolvedValue(null);
    expect((await get('stellar-testnet', '9')).status).toBe(404);
  });
});
