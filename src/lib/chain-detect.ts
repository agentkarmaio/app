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
 * Return the Chain whose adapter recognizes `address`, or null if none do.
 * Adapters validate disjoint address formats (base58 vs StrKey), so the first
 * match is unambiguous.
 */
export function detectChain(address: string): Chain | null {
  if (!address) return null;
  for (const adapter of getAllAdapters()) {
    if (adapter.validateAddress(address)) return adapter.chain;
  }
  return null;
}

/**
 * Resolve the chain for a request. When `param` is provided it MUST be a known
 * chain AND the address must be valid for that chain. When `param` is absent,
 * fall back to format detection. Returns null on any mismatch — callers map
 * null → 400.
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
