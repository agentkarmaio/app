import { CHAINS, type Chain } from '@/db/schema';

/**
 * Parse a `?chain=` query value to a valid Chain, or undefined (= no filter).
 * Mirrors parseStatus/parseTier in app/api/leaderboard/route.ts. Case-sensitive
 * against the canonical CHAINS tuple so it auto-extends when U1 adds 'stellar'.
 */
export function parseChain(value: string | null | undefined): Chain | undefined {
  return value && (CHAINS as readonly string[]).includes(value)
    ? (value as Chain)
    : undefined;
}
