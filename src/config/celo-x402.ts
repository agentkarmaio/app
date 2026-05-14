/**
 * Celo x402 settlement-token registry + facilitator config.
 *
 * Celo's x402 model differs from Solana: there is no canonical facilitator —
 * each operator brings their own server wallet. Instead of scanning the full
 * chain, AK indexes ERC-20 Transfer events from a curated list of facilitator
 * addresses (`CELO_X402_FACILITATORS`). The list grows as we discover
 * facilitators in the wild via partner outreach and ecosystem indexing.
 *
 * Token list is canonical per docs.celo.org/build-on-celo/build-with-ai/x402.
 * cUSD is explicitly NOT in Thirdweb's x402 token allowlist on Celo.
 */

export interface CeloX402Token {
  symbol: 'USDC' | 'USDT' | 'USDm';
  address: `0x${string}`;
  decimals: number;
}

export const CELO_X402_TOKENS: CeloX402Token[] = [
  { symbol: 'USDC', address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', decimals: 6 },
  { symbol: 'USDT', address: '0x48065fBBE25f71C9282ddf5e1cD6D6A887483D5e', decimals: 6 },
  { symbol: 'USDm', address: '0x765DE816845861e75A25fCa122bb6898B8B1282a', decimals: 18 },
];

export interface CeloX402Facilitator {
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
 * Curated list of Celo x402 facilitator addresses AK watches for settlement
 * events. Populated by:
 *   1. Manual entries when operators reach out / are surfaced via Self/grant
 *      ecosystem connections (M2 milestone activity).
 *   2. Scheduled scans of the Thirdweb x402 facilitator registry, if/when
 *      Thirdweb publishes one (not present at time of writing).
 *   3. Inference from public Self Agent ID anchorings — wallets that complete
 *      AK's `/verify-self` flow are candidates for facilitator discovery.
 *
 * Empty by default. Add an entry, redeploy, indexer picks it up on next run.
 */
export const CELO_X402_FACILITATORS: CeloX402Facilitator[] = [];

/** Address lookup by lowercased hex. */
export function getCeloFacilitator(addr: string): CeloX402Facilitator | undefined {
  const lc = addr.toLowerCase();
  return CELO_X402_FACILITATORS.find((f) => f.address.toLowerCase() === lc);
}

/** Token lookup by lowercased hex. */
export function getCeloX402Token(addr: string): CeloX402Token | undefined {
  const lc = addr.toLowerCase();
  return CELO_X402_TOKENS.find((t) => t.address.toLowerCase() === lc);
}
