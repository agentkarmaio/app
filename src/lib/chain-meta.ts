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

/** EVM chains share the same injected-wallet (EIP-1193) connection path. */
export function isEvmChain(chain: Chain): boolean {
  return chain === 'celo' || chain === 'arc';
}

/**
 * Detail routes pinned to a single resolved agent. The chain switcher MUST NOT
 * navigate away from these — on an agent page it switches the active-chain
 * context in place (which wallet the Connect button offers) rather than pushing
 * the user to a chain landing page and losing the agent they're viewing.
 */
export function isAgentPath(pathname: string): boolean {
  return pathname === '/agent' || pathname.startsWith('/agent/');
}

/**
 * Lightweight client-side guess of an agent's chain from its `/agent/<address>`
 * URL, used only to seed the switcher's initial selection on an agent page (the
 * authoritative resolution is server-side `resolveAgentChain`). Regex-only so it
 * stays out of the chain-adapter bundle. Solana (base58) and Stellar (StrKey)
 * are format-unique; an EVM 0x address is Celo/Arc-ambiguous, so we seed Celo
 * (both EVM chains share one wallet button) and the navbar refines the label
 * from a `?chain=` query param when present.
 */
export function agentChainFromPath(pathname: string): Chain {
  const seg = pathname.startsWith('/agent/') ? pathname.slice('/agent/'.length).split('/')[0] : '';
  const address = decodeURIComponent(seg);
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) return 'celo';  // EVM (Celo/Arc) — seed Celo
  if (/^G[A-Z2-7]{55}$/.test(address)) return 'stellar';   // Stellar StrKey public key
  return DEFAULT_CHAIN;                                     // base58 / anything else → Solana
}

/**
 * Derive the active chain from the pathname via longest-prefix match. Solana is
 * the fallback (its href is '/', which is not treated as a prefix). Shared by
 * the navbar (which connect button to show) and the chain switcher.
 */
export function activeChainFromPath(pathname: string): Chain {
  let best: Chain = DEFAULT_CHAIN;
  let bestLen = -1;
  for (const c of chainOptions()) {
    const href = CHAIN_META[c].href;
    if (href === '/') continue; // solana is the fallback, not a prefix
    if ((pathname === href || pathname.startsWith(href + '/')) && href.length > bestLen) {
      best = c;
      bestLen = href.length;
    }
  }
  return best;
}
