import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { NextRequest } from 'next/server';
import * as db from '@/db/client';
import * as limits from '@/lib/rate-limit';
import type { Wallet } from '@/db/schema';
import { GET } from './route';

const restores: Array<() => void> = [];
function track<T extends { mockRestore(): void }>(spy: T): T { restores.push(() => spy.mockRestore()); return spy; }
afterEach(() => restores.splice(0).reverse().forEach(restore => restore()));
beforeEach(() => track(spyOn(limits, 'enforceRateLimit').mockResolvedValue({ ok: true, headers: {} } as never)));
const wallet = (address: string, score: number, provider: number | null = score): Wallet => ({ chain: 'arc-mainnet', address,
  score, provider_score: provider, trust_tier: 'Unrated', tx_count: 1 }) as Wallet;

test('wallet graph drops unassessed mainnet rows and collapses shared registry wallets before allocating slots', async () => {
  track(spyOn(db, 'getLeaderboard').mockImplementation(async (_limit, _offset, filters) => ({ total: 5,
    wallets: filters?.chain === 'arc-mainnet'
      ? [wallet('shared', 25), wallet('shared', 25), wallet('second', 10), wallet('absent', 20, null), wallet('zero', 0)] : [],
  })));
  const body = await (await GET(new NextRequest('http://localhost/api/graph'))).json();
  expect(body.agents.map((a: {address:string}) => a.address)).toEqual(['shared', 'second']);
  expect(body.agents.every((a: {chain:string;score:number}) => a.chain === 'arc-mainnet' && typeof a.score === 'number' && a.score > 0)).toBe(true);
});

test('empty mainnet activity slots redistribute to the existing chain pools', async () => {
  track(spyOn(db, 'getLeaderboard').mockImplementation(async (_limit, _offset, filters) => ({ total: 12,
    wallets: filters?.chain === 'arc-mainnet' ? [wallet('absent', 0, null)]
      : filters?.chain === 'celo' || filters?.chain === 'stellar'
        ? Array.from({ length: 12 }, (_, i) => ({ ...wallet(`${filters.chain}-${i}`, 25), chain: filters.chain as 'celo' | 'stellar' })) : [],
  })));
  const body = await (await GET(new NextRequest('http://localhost/api/graph'))).json();
  expect(body.agents).toHaveLength(18);
  expect(body.agents.some((a: {chain:string}) => a.chain === 'arc-mainnet')).toBe(false);
});
