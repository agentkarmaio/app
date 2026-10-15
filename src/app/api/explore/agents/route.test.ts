/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { NextRequest } from 'next/server';
import * as db from '@/db/client';
import type { Wallet } from '@/db/schema';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET } from './route';

const base = {
  address: 'GC2NIKT6TWLMBZE4TU5ZMMDVV22URFIMJIZ4JYUC3QABBBWNGGZMAFGM',
  first_seen: '2026-10-01T00:00:00Z', tx_count: 0, score: 40, trust_tier: 'Fair', updated_at: '2026-10-01T00:00:00Z',
  last_seen: null, stellar_agent_id: 10,
};

let agents: ReturnType<typeof spyOn<typeof db, 'getAgents'>>;
beforeEach(() => { agents = spyOn(db, 'getAgents'); });
afterEach(() => { agents.mockRestore(); __resetRateLimitForTests(); });

const get = (qs = '') => GET(new NextRequest(`http://x/api/explore/agents${qs}`));
const rows = async (res: Response) => (await res.json()).wallets as Array<Record<string, unknown>>;

describe('GET /api/explore/agents payment totals', () => {
  test('a stellar-testnet row carries payments { received, usdcReceived, lastReceivedAt }', async () => {
    agents.mockResolvedValue({ total: 1, wallets: [{ ...base, chain: 'stellar-testnet',
      payments_received: 2, payments_usdc_received: '1.000000000000000000',
      payments_last_received_at: '2026-10-14T10:00:00+00:00' } as unknown as Wallet] });
    const [row] = await rows(await get('?chain=stellar-testnet'));
    expect(row.payments).toEqual({ received: 2, usdcReceived: '1.0000000', lastReceivedAt: '2026-10-14T10:00:00.000Z' });
  });

  test('bigint counts arrive as strings from PostgREST and are returned as integers', async () => {
    agents.mockResolvedValue({ total: 1, wallets: [{ ...base, chain: 'stellar-testnet',
      payments_received: '5', payments_usdc_received: '0.0500000000',
      payments_last_received_at: null } as unknown as Wallet] });
    const [row] = await rows(await get('?chain=stellar-testnet'));
    expect(row.payments).toEqual({ received: 5, usdcReceived: '0.0500000', lastReceivedAt: null });
  });

  test('an agent with no payments reports zero, not missing', async () => {
    agents.mockResolvedValue({ total: 1, wallets: [{ ...base, chain: 'stellar-testnet',
      payments_received: 0, payments_usdc_received: '0', payments_last_received_at: null } as unknown as Wallet] });
    const [row] = await rows(await get('?chain=stellar-testnet'));
    expect(row.payments).toEqual({ received: 0, usdcReceived: '0.0000000', lastReceivedAt: null });
  });

  test('other chains keep their exact shape (no payments key)', async () => {
    agents.mockResolvedValue({ total: 1, wallets: [{ ...base, chain: 'stellar' } as unknown as Wallet] });
    const [row] = await rows(await get('?chain=stellar'));
    expect(row).not.toHaveProperty('payments');
  });

  test('limit is capped at 100', async () => {
    agents.mockResolvedValue({ total: 0, wallets: [] });
    const body = await (await get('?chain=stellar-testnet&limit=5000')).json();
    expect(body.limit).toBe(100);
    expect(agents.mock.calls[0][0]).toBe(100);
  });
});
