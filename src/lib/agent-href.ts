import type { Chain } from '@/db/schema';

/**
 * Build the /agent/[wallet] URL. EVM chains (celo, arc) share the 0x…40hex
 * address format, so the route cannot tell them apart from the address alone —
 * append `?chain=` so resolveAgentChain picks the right wallet row. Solana
 * (base58) and Stellar (G-strkey) are format-unique and need no hint.
 */
export function agentHref(a: { chain: Chain; address: string; agentId?: number | null }): string {
  const base = `/agent/${a.address}`;
  if (a.chain === 'celo' || a.chain === 'arc') {
    // agentId disambiguates the many agents sharing one owner address: the page
    // resolves the registry profile by it even when the owner isn't in `wallets`.
    const q = a.agentId != null ? `?chain=${a.chain}&agentId=${a.agentId}` : `?chain=${a.chain}`;
    return `${base}${q}`;
  }
  return base;
}
