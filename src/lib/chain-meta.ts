import { CHAINS, type Chain } from '@/db/schema';

export const DEFAULT_CHAIN: Chain = 'solana';

/**
 * Chain the header switcher shows on pages that aren't pinned to a chain
 * (`/`, `/explore`, `/protocol`, …). Display-only — deliberately NOT
 * `DEFAULT_CHAIN`, which is the data-layer default behind ~25 `db/client.ts`
 * signatures and must stay `solana` for back-compat.
 */
export const UI_DEFAULT_CHAIN: Chain = 'stellar';

export interface ChainMeta {
  label: string;
  /** Public path to the chain's brand mark (SVG, brand color baked in). */
  logo: string;
  /** Where the switcher links for this chain's context page. */
  href: string;
}

/**
 * Display metadata for every supported chain. Keyed by Chain so adding a chain
 * to CHAINS is a compile error here until metadata exists. Every chain owns a
 * dedicated context page — Solana → /solana, Celo → /celo, Stellar → /stellar,
 * Arc → /arc. None maps to '/', which is the chain-neutral home.
 */
export const CHAIN_META: Record<Chain, ChainMeta> = {
  solana: { label: 'Solana', logo: '/logos/solana-mark.svg', href: '/solana' },
  celo: { label: 'Celo', logo: '/logos/celo.svg', href: '/celo' },
  stellar: { label: 'Stellar', logo: '/logos/stellar.svg', href: '/stellar' },
  // Arc network icon per Arc brand guidelines §3.4 — that asset is the one
  // reserved for referencing the network (the yellow badge means the ARC
  // token). Its navy disc is part of the mark; never dim or recolor it.
  arc: { label: 'Arc', logo: '/logos/arc-network.svg', href: '/arc' },
};

/** Solana first, then remaining chains in CHAINS declaration order.
 *  Ordering is independent of UI_DEFAULT_CHAIN — the default is which chain a
 *  chain-neutral page reads as, not which one heads the dropdown. */
export function chainOptions(): Chain[] {
  return [...CHAINS];
}

/** EVM chains share the same injected-wallet (EIP-1193) connection path. */
export function isEvmChain(chain: Chain): boolean {
  return chain === 'celo' || chain === 'arc';
}

/**
 * Chains whose canonical agent population lives in the `erc8004_agents` mirror
 * (one row per agentId) rather than the address-keyed `wallets` table. On these
 * registries a single owner controls many agents, so an address-keyed read
 * undercounts badly — Stellar's 67 agentIds collapse to 11 owner rows.
 *
 * Deliberately NOT the same set as isEvmChain: Stellar is a Soroban registry
 * with no EVM wallet path. Conflating the two would route Stellar down the
 * EIP-1193 connect flow.
 */
export function isRegistryMirrorChain(chain: Chain | null | undefined): chain is Chain {
  return chain === 'celo' || chain === 'arc' || chain === 'stellar';
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
 *
 * The base58 fallback is address-class inference, not a display preference — it
 * is pinned to 'solana' and must never follow UI_DEFAULT_CHAIN.
 */
export function agentChainFromPath(pathname: string): Chain {
  const seg = pathname.startsWith('/agent/') ? pathname.slice('/agent/'.length).split('/')[0] : '';
  const address = decodeURIComponent(seg);
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) return 'celo';  // EVM (Celo/Arc) — seed Celo
  if (/^G[A-Z2-7]{55}$/.test(address)) return 'stellar';   // Stellar StrKey public key
  return 'solana';                                          // base58 / anything else → Solana
}

/**
 * Derive the active chain from the pathname via longest-prefix match. Every
 * chain owns a context page, so '/' matches nothing and falls back to
 * UI_DEFAULT_CHAIN. Shared by the navbar (which connect button to show) and the
 * chain switcher.
 */
export function activeChainFromPath(pathname: string): Chain {
  let best: Chain = UI_DEFAULT_CHAIN;
  let bestLen = -1;
  for (const c of chainOptions()) {
    const href = CHAIN_META[c].href;
    if ((pathname === href || pathname.startsWith(href + '/')) && href.length > bestLen) {
      best = c;
      bestLen = href.length;
    }
  }
  return best;
}
