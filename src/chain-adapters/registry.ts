/**
 * ChainAdapter registry — single lookup point. getAdapter(chain) for dispatch,
 * getAllAdapters() for fan-out (cron, leaderboard). Adapters are singletons.
 */
import type { Chain } from '@/db/schema';
import type { ChainAdapter } from './types';
import { makeSolanaAdapter } from './solana';
import { makeCeloAdapter } from './celo';
import { makeStellarAdapter } from './stellar';
import { makeArcAdapter } from './arc';

const _adapters: Map<Chain, ChainAdapter> = new Map([
  ['solana',  makeSolanaAdapter()],
  ['celo',    makeCeloAdapter()],
  ['stellar', makeStellarAdapter()],
  ['arc',     makeArcAdapter()],
]);

export function getAdapter(chain: Chain): ChainAdapter {
  const adapter = _adapters.get(chain);
  if (!adapter) throw new Error(`No ChainAdapter for chain: ${chain}`);
  return adapter;
}

export function getAllAdapters(): ChainAdapter[] {
  return [..._adapters.values()];
}
