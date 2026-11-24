/**
 * Robinhood Chain (EVM, chainId 4663). Registry-only in AgentKarma: the
 * canonical ERC-8004 pair is mirrored and scored from declared metadata; there
 * is no payment indexer on this chain.
 *
 * Spec: docs/superpowers/specs/2026-11-24-robinhood-chain-8004-registry.md
 */
import { robinhood } from 'viem/chains';

/** viem's own definition: id 4663, ETH, Multicall3, Blockscout, public RPC. */
export const robinhoodChain = robinhood;
export const ROBINHOOD_CHAIN_ID = 4663;

/**
 * tokenURI hosts minted in bulk by one or two registrants (measured
 * 2026-11-24: 23,068 of 26,458 agents). Their ids get an identity read and
 * nothing else: no mirror row, no explore row, no public count. Subdomains are
 * excluded with their host. `explore-agents-view.sql` repeats this list; a test
 * holds the two in step.
 */
export const ROBINHOOD_EXCLUDED_REGISTRATION_HOSTS: readonly string[] = [
  'hoodai.fly.dev',        // 10.5k "harmless canary" probe cards
  'bv7x.ai',               // 9.1k templated strategy agents, 2 registrants
  'musegod.org',
  'api.alpharc.app',
  'ohmies.squareapes.com',
  'launch.fomo4nft.com',
  'api.synths.lol',
  'api.meshgateway.co',
];

/**
 * Optional RPC override. Unset → viem's public endpoint (keyless). A set value
 * must be a plain https URL; provider URLs can carry secrets, so the supplied
 * value never appears in the error.
 */
export function parseRobinhoodRpcUrl(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) throw new Error();
    return url.toString();
  } catch {
    throw new Error('configuration_invalid');
  }
}
