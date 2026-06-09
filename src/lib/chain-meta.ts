import { CHAINS, type Chain } from '@/db/schema';

export const DEFAULT_CHAIN: Chain = 'solana';

export interface ChainMeta {
  label: string;
  /** Public path to the chain's brand mark (SVG, brand color baked in). */
  logo: string;
  /** Where the switcher links for this chain's context page. */
  href: string;
}

/**
 * Display metadata for every supported chain. Keyed by Chain so adding a chain
 * to CHAINS is a compile error here until metadata exists. Solana has no
 * dedicated context page → links home ('/'); Celo → /celo; Stellar → /stellar.
 */
export const CHAIN_META: Record<Chain, ChainMeta> = {
  solana: { label: 'Solana', logo: '/logos/solana-mark.svg', href: '/' },
  celo: { label: 'Celo', logo: '/logos/celo.svg', href: '/celo' },
  stellar: { label: 'Stellar', logo: '/logos/stellar.svg', href: '/stellar' },
  arc: { label: 'Arc', logo: '/logos/arc.svg', href: '/arc' },
};

/** Solana first, then remaining chains in CHAINS declaration order. */
export function chainOptions(): Chain[] {
  return [...CHAINS];
}
