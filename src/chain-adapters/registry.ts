/**
 * ChainAdapter registry — single lookup point. getAdapter(chain) for dispatch,
 * getAllAdapters() for fan-out (cron, leaderboard). Adapters are singletons.
 */
import { isPublicChain, type Chain } from '@/db/schema';
import type { ChainAdapter } from './types';
import { makeSolanaAdapter } from './solana';
import { makeCeloAdapter } from './celo';
import { makeStellarAdapter, makeStellarTestnetAdapter } from './stellar';
import { makeArcAdapter } from './arc';
import { makeArcMainnetAdapter } from './arc-mainnet';

const _adapters: Map<Chain, ChainAdapter> = new Map([
  ['solana',  makeSolanaAdapter()],
  ['celo',    makeCeloAdapter()],
  ['stellar', makeStellarAdapter()],
  ['arc',     makeArcAdapter()],
  ['arc-mainnet', makeArcMainnetAdapter()],
  ['stellar-testnet', makeStellarTestnetAdapter()],
]);

export function getAdapter(chain: Chain): ChainAdapter {
  const adapter = _adapters.get(chain);
  if (!adapter) throw new Error(`No ChainAdapter for chain: ${chain}`);
  return adapter;
}

/**
 * Fan-out set (cron, format detection). Excludes NON_PUBLIC_CHAINS: retired
 * Arc testnet, and API-only stellar-testnet, whose G-addresses would otherwise
 * make every Stellar address ambiguous in detectChain. Both still resolve
 * through getAdapter when explicitly pinned.
 */
export function getAllAdapters(): ChainAdapter[] {
  return [..._adapters.values()].filter((adapter) => isPublicChain(adapter.chain));
}
