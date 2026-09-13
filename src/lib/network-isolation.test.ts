import { afterEach, expect, test } from 'bun:test';
import { __setSupabaseForTest } from '@/db/client';
import { resolveAgentChain } from '@/app/agent/[wallet]/resolve-chain';
import { agentHref } from './agent-href';
import { CHAIN_META, activeChainFromPath, isEvmChain } from './chain-meta';
import { buildIndexingHealth } from './indexing-health';
import { parseActivityHealth } from '@/components/karma/live-flow-state';
import type { Chain } from '@/db/schema';
import { resolveKarma } from './karma-resolver';

const address = '0x558e7bfaf2cf1a494f44e50d92431afc060c9d12';
afterEach(() => __setSupabaseForTest(null));

function walletRows(chains: string[]) {
  __setSupabaseForTest({ from() {
    const query = {
      select() { return query; }, eq() { return query; },
      order: async () => ({ data: chains.map(chain => ({ chain, address })), error: null }),
    };
    return query;
  } });
}

test('an explicit network pin never falls back to the sole wallet on another network', async () => {
  walletRows(['arc']);
  const result = await resolveAgentChain(address, 'celo');
  expect(result.chain).toBe('celo');
  expect(result.wallet).toBeNull();
});

test('an absent mainnet identity stays mainnet when testnet already knows the address', async () => {
  walletRows(['arc', 'celo']);
  const result = await resolveAgentChain(address, 'arc-mainnet');
  expect(result.chain).toBe('arc-mainnet');
  expect(result.wallet).toBeNull();
});

test('mainnet empty lookup retains its explicit network', async () => {
  walletRows([]);
  expect((await resolveAgentChain(address, 'arc-mainnet')).chain).toBe('arc-mainnet');
});

test('mainnet identity links retain the network and agent id', () => {
  expect(agentHref({ chain: 'arc-mainnet' as Chain, address, agentId: 7 }))
    .toBe(`/agent/${address}?chain=arc-mainnet&agentId=7`);
});

test('Arc testnet and mainnet have distinct labels and navigation', () => {
  expect(CHAIN_META.arc.label).toBe('Arc testnet');
  expect(CHAIN_META['arc-mainnet' as Chain]?.label).toBe('Arc mainnet');
  expect(activeChainFromPath('/arc/mainnet')).toBe('arc-mainnet');
  expect(isEvmChain('arc-mainnet' as Chain)).toBe(true);
});

test('health consumer accepts separate Arc networks without losing existing paths', () => {
  const health = buildIndexingHealth([]);
  expect(health.chains.map(chain => chain.chain)).toContain('arc-mainnet');
  expect(health.chains.find(chain => chain.chain === 'arc')?.paths).toHaveLength(3);
  expect(parseActivityHealth(health)).toEqual(health);
});

test('mainnet score lookup pins every evidence read even when the wallet is absent', async () => {
  const filters: string[] = [];
  __setSupabaseForTest({ from(table: string) {
    const query = {
      select() { return query; }, order() { return query; }, limit() { return query; }, range() { return query; },
      eq(column: string, value: unknown) { filters.push(`${table}.${column}=${value}`); return query; },
      single: async () => ({ data: null, error: { code: 'PGRST116' } }),
      then(resolve: (value: unknown) => void) { resolve({ data: [], error: null }); },
    };
    return query;
  } });
  expect(await resolveKarma(address, 'arc-mainnet' as Chain)).toBeNull();
  expect(filters.some(filter => filter.startsWith('transactions.'))).toBe(false);
  for (const table of ['wallets', 'signal_events']) {
    expect(filters).toContain(`${table}.chain=arc-mainnet`);
    expect(filters).not.toContain(`${table}.chain=arc`);
    expect(filters).not.toContain(`${table}.chain=solana`);
  }
});
