import { CHAINS, type Chain } from '@/db/schema';

export const DEFAULT_CHAIN: Chain = 'solana';

export interface ChainMeta {
  label: string;
  /** Tailwind text color for the accent dot/label. */
  accent: string;
  /** Where the switcher links for this chain's context page. */
  href: string;
}

/**
 * Display metadata for every supported chain. Keyed by Chain so adding a chain
 * to CHAINS is a compile error here until metadata exists. Solana has no
 * dedicated context page → links home ('/'); Celo → /celo; Stellar → /stellar.
 */
export const CHAIN_META: Record<Chain, ChainMeta> = {
  solana: { label: 'Solana', accent: 'text-[#14f195]', href: '/' },
  celo: { label: 'Celo', accent: 'text-[#fcff52]', href: '/celo' },
  stellar: { label: 'Stellar', accent: 'text-[#7d00ff]', href: '/stellar' },
};

/** Solana first, then remaining chains in CHAINS declaration order. */
export function chainOptions(): Chain[] {
  return [...CHAINS];
}
