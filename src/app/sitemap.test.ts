import { afterEach, expect, spyOn, test } from 'bun:test';
import * as db from '@/db/client';
import type { Wallet } from '@/db/schema';
import sitemap from './sitemap';

const restores: Array<() => void> = [];
function track<T extends { mockRestore(): void }>(spy: T): T { restores.push(() => spy.mockRestore()); return spy; }
afterEach(() => restores.splice(0).reverse().forEach(restore => restore()));

test('sitemap includes the mainnet landing route and pins mainnet agent URLs without changing existing routes', async () => {
  track(spyOn(db, 'getLeaderboard').mockResolvedValue({ total: 3, wallets: [
    { chain: 'arc-mainnet', address: 'shared', arc_agent_id: 0 },
    { chain: 'arc-mainnet', address: 'other', arc_agent_id: null },
    { chain: 'solana', address: 'solana-wallet' },
  ] as Wallet[] }));
  track(spyOn(db, 'listOrganizations').mockResolvedValue([]));
  const urls = (await sitemap()).map(entry => entry.url);
  expect(urls).toContain('https://agentkarma.io/arc/mainnet');
  expect(urls).toContain('https://agentkarma.io/agent/shared?chain=arc-mainnet&agentId=0');
  expect(urls).toContain('https://agentkarma.io/agent/other?chain=arc-mainnet');
  expect(urls).toContain('https://agentkarma.io/agent/solana-wallet');
});
