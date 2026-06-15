/**
 * Per-route helper: resolve the chain context for an /agent/[wallet] URL.
 *
 * The URL is just an address — no chain pin. We first inspect the address
 * format (Solana base58 / Stellar StrKey / EVM 0x40hex) to narrow the search,
 * then look in the DB. Solana and Stellar are format-unique. Celo and Arc are
 * BOTH EVM, so an EVM address may match zero, one, or two wallet rows; we
 * surface the full match list so the page can render a chain selector when it
 * matters.
 *
 * Pure-ish: one DB read. No on-chain RPC calls.
 */

import { detectChain } from '@/lib/chain-detect';
import { getWallet, getWalletsByAddressAnyChain } from '@/db/client';
import { isChain, type Chain, type Wallet } from '@/db/schema';

export type AddressClass = 'solana' | 'stellar' | 'evm' | 'unknown';

/**
 * Cheap address-format class without DB lookup. Stays decoupled from chain
 * resolution so callers can render a chain-appropriate stub even when no
 * DB row exists. EVM groups Celo + Arc since they're indistinguishable.
 */
export function classifyAddress(address: string): AddressClass {
  if (!address) return 'unknown';
  const chain = detectChain(address); // null for EVM (Celo/Arc ambiguous) and for junk
  if (chain === 'solana') return 'solana';
  if (chain === 'stellar') return 'stellar';
  // 0x…40hex passes Celo + Arc adapter validation but detectChain returns null
  // because more than one adapter matched. Recognize the EVM class directly.
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) return 'evm';
  return 'unknown';
}

export interface ResolvedChain {
  /** Address format class — drives stub copy when no DB row exists. */
  addressClass: AddressClass;
  /** Best-fit chain. Null when EVM address matches multiple rows (ambiguous). */
  chain: Chain | null;
  /** Wallet row chosen for rendering, if any. */
  wallet: Wallet | null;
  /** All DB rows for this address across chains — non-empty implies ambiguity. */
  candidates: Wallet[];
}

/**
 * Resolve the chain for an /agent/[wallet] URL.
 *
 * - Solana → fetch the Solana row directly (single composite-PK read).
 * - Stellar → fetch the Stellar row directly.
 * - EVM → fetch ALL rows for the address (Celo + Arc possible). If exactly
 *   one row matches, use it. If two match, surface both candidates so the
 *   caller can render a selector; the default render falls back to Celo
 *   (richer integration today). If zero match, return chain=null and let
 *   the caller render an EVM-flavored stub.
 * - Unknown → all nulls.
 */
export async function resolveAgentChain(
  address: string,
  chainHint?: string,
): Promise<ResolvedChain> {
  const addressClass = classifyAddress(address);
  const hint: Chain | undefined = isChain(chainHint) ? chainHint : undefined;

  if (addressClass === 'unknown') {
    return { addressClass, chain: null, wallet: null, candidates: [] };
  }

  if (addressClass === 'solana') {
    const wallet = await getWallet(address, 'solana').catch(() => null);
    return {
      addressClass,
      chain: 'solana',
      wallet,
      candidates: wallet ? [wallet] : [],
    };
  }

  if (addressClass === 'stellar') {
    const wallet = await getWallet(address, 'stellar').catch(() => null);
    return {
      addressClass,
      chain: 'stellar',
      wallet,
      candidates: wallet ? [wallet] : [],
    };
  }

  // EVM — Celo and Arc both possible. One DB read across both.
  const candidates = await getWalletsByAddressAnyChain(address).catch(() => []);
  if (candidates.length === 0) {
    return { addressClass, chain: null, wallet: null, candidates: [] };
  }
  if (candidates.length === 1) {
    return {
      addressClass,
      chain: candidates[0].chain,
      wallet: candidates[0],
      candidates,
    };
  }
  // Multiple rows. Honor the explicit ?chain= hint when it matches a candidate
  // (this is how an Arc row is reached for an address also registered on Celo).
  // Without a hint, prefer Celo (deeper integration today); both rows remain in
  // `candidates` so callers can offer a chain switcher.
  const preferred =
    (hint && candidates.find((w) => w.chain === hint)) ??
    candidates.find((w) => w.chain === 'celo') ??
    candidates[0];
  return {
    addressClass,
    chain: preferred.chain,
    wallet: preferred,
    candidates,
  };
}
