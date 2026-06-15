import type { Chain } from '@/db/schema';

/**
 * Build the /agent/[wallet] URL. EVM chains (celo, arc) share the 0x…40hex
 * address format, so the route cannot tell them apart from the address alone —
 * append `?chain=` so resolveAgentChain picks the right wallet row. Solana
 * (base58) and Stellar (G-strkey) are format-unique and need no hint.
 */
export function agentHref(a: { chain: Chain; address: string }): string {
  const base = `/agent/${a.address}`;
  return a.chain === 'celo' || a.chain === 'arc' ? `${base}?chain=${a.chain}` : base;
}
