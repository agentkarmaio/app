/**
 * Arc x402 settlement-token registry + facilitator config.
 *
 * Arc is a USDC-native EVM L1 (testnet). Like Celo, there is no canonical
 * facilitator — each operator brings their own server wallet. Instead of
 * scanning the full chain, AK indexes ERC-20 Transfer events from a curated
 * list of facilitator addresses (`ARC_X402_FACILITATORS`). The list grows as
 * we discover facilitators in the wild via partner outreach and ecosystem
 * indexing.
 *
 * Settlement runs on the native USDC ERC-20 token (6-decimal token units —
 * NOT the 18-decimal native gas accounting).
 */

export interface ArcX402Token {
  symbol: 'USDC';
  address: `0x${string}`;
  decimals: number;
}

export const ARC_X402_TOKENS: ArcX402Token[] = [
  { symbol: 'USDC', address: '0x3600000000000000000000000000000000000000', decimals: 6 },
];

export interface ArcX402Facilitator {
  /** EVM address of the facilitator's server wallet. */
  address: `0x${string}`;
  /** Display name. Empty string allowed for anonymous facilitators. */
  name: string;
  /** Optional homepage / docs URL for the operator. */
  url?: string;
  /** When AK first observed this facilitator. */
  discoveredAt: string; // ISO date
}

/**
 * Curated list of Arc x402 facilitator addresses AK watches for settlement
 * events. Populated by:
 *   1. Manual entries when operators reach out / are surfaced via ecosystem
 *      connections.
 *   2. Scheduled scans of any x402 facilitator registry, if/when one is
 *      published for Arc (not present at time of writing).
 *   3. Inference from public agent registrations on Arc's ERC-8004 deployment.
 *
 * Empty by default. Add an entry, redeploy, indexer picks it up on next run.
 */
export const ARC_X402_FACILITATORS: ArcX402Facilitator[] = [];

/** Address lookup by lowercased hex. */
export function getArcFacilitator(addr: string): ArcX402Facilitator | undefined {
  const lc = addr.toLowerCase();
  return ARC_X402_FACILITATORS.find((f) => f.address.toLowerCase() === lc);
}

/** Token lookup by lowercased hex. */
export function getArcX402Token(addr: string): ArcX402Token | undefined {
  const lc = addr.toLowerCase();
  return ARC_X402_TOKENS.find((t) => t.address.toLowerCase() === lc);
}
