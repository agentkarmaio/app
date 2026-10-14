import { isSiteChain, type Chain } from '@/db/schema';

/**
 * Parse a `?chain=` query value to a valid Chain, or undefined (= no filter).
 * Mirrors parseStatus/parseTier in app/api/leaderboard/route.ts. Case-sensitive
 * against the canonical CHAINS tuple, minus API-only chains.
 */
export function parseChain(value: string | null | undefined): Chain | undefined {
  // Site chains only: API-only stellar-testnet is not a leaderboard filter.
  return isSiteChain(value) ? value : undefined;
}
