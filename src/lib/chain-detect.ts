/**
 * Chain detection / dispatch for address-keyed routes (score API, manifest
 * refresh) and the MCP surface. Single source of truth so every entry point
 * agrees on which ChainAdapter owns a given address.
 *
 * Pure: only calls adapters' synchronous `validateAddress`. No I/O.
 */

import { isChain, type Chain } from '@/db/schema';
import { getAllAdapters, getAdapter } from '@/chain-adapters/registry';

/**
 * Return the Chain whose adapter recognizes `address`, or null if none do — OR
 * if more than one does. Solana (base58) and Stellar (StrKey) are format-
 * disjoint, but Celo and Arc are BOTH EVM (0x…40hex) and indistinguishable by
 * format, so an EVM address is AMBIGUOUS and returns null. Auto-detection MUST
 * NOT scope a per-chain DB read for an EVM address — require an explicit chain
 * pin. For a plain "is this a usable address" gate, use `isRecognizedAddress`.
 */
export function detectChain(address: string): Chain | null {
  if (!address) return null;
  const matches = getAllAdapters().filter((a) => a.validateAddress(address));
  return matches.length === 1 ? matches[0].chain : null;
}

/**
 * True if ANY adapter recognizes the address format. Unlike `detectChain`, this
 * accepts an unpinned EVM address (valid but chain-ambiguous) — use it for
 * validity gates where the chain isn't needed (reads are address-keyed).
 */
export function isRecognizedAddress(address: string): boolean {
  return !!address && getAllAdapters().some((a) => a.validateAddress(address));
}

/**
 * Resolve the chain for a request. When `param` is provided it MUST be a known
 * chain AND the address must be valid for that chain. When `param` is absent,
 * fall back to format detection — which returns null for an EVM address (Celo
 * vs Arc is unresolvable without a pin). Returns null on any mismatch. Callers
 * that only need a validity gate (not the chain) should use isRecognizedAddress
 * so an unpinned EVM address isn't rejected as invalid.
 */
export function resolveChainParam(
  param: string | null | undefined,
  address: string,
): Chain | null {
  if (param) {
    if (!isChain(param)) return null;
    return getAdapter(param).validateAddress(address) ? param : null;
  }
  return detectChain(address);
}
