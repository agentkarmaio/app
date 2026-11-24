import type { Chain } from '@/db/schema';
import { isEvmChain } from './chain-meta';

/**
 * Build the /agent/[wallet] URL. EVM chains (celo, arc) share the 0x…40hex
 * address format, so the route cannot tell them apart from the address alone —
 * append `?chain=` so resolveAgentChain picks the right wallet row. Solana
 * (base58) and Stellar (G-strkey) are format-unique and need no hint.
 */
export function agentHref(a: { chain: Chain; address: string; agentId?: number | null }): string {
  const base = `/agent/${a.address}`;
  if (isEvmChain(a.chain)) {
    // agentId disambiguates the many agents sharing one owner address: the page
    // resolves the registry profile by it even when the owner isn't in `wallets`.
    const q = a.agentId != null ? `?chain=${a.chain}&agentId=${a.agentId}` : `?chain=${a.chain}`;
    return `${base}${q}`;
  }
  return base;
}

/**
 * Registry agentId carried by a leaderboard/explore row on a chain whose agents
 * are keyed by agentId rather than wallet (Arc mainnet, Robinhood Chain), else
 * undefined. Celo/Stellar rows link by address for back-compat.
 */
export function registryRowAgentId(w: {
  chain: Chain; arc_agent_id?: number | null; robinhood_agent_id?: number | null;
}): number | null | undefined {
  if (w.chain === 'arc-mainnet') return w.arc_agent_id ?? null;
  if (w.chain === 'robinhood') return w.robinhood_agent_id ?? null;
  return undefined;
}

