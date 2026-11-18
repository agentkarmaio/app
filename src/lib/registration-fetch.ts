/**
 * ERC-8004 registration fetch, shared by the registry mirror
 * (src/indexer/erc8004-registry.ts) and the live EVM read surfaces
 * (erc8004-evm / -arc / -celo). One scheme map for both: when they diverged,
 * the mirror resolved ipfs:// while the live path threw, so ipfs-hosted agents
 * were mirror-eligible but live-scored 0 and the Arc drip re-drew them daily.
 */

import { decodeDataUriJson } from './data-uri';
import { safeFetchJson } from './ssrf-guard';

/**
 * ipfs.io retired its path gateway on 2026-09-13 and now answers every request
 * with 429, which banked 1,949 agents across arc/celo/solana as `unreachable`
 * (48% of a sampled 52 were valid registrations). Filebase serves the same CIDs
 * in ~100ms. Overridable so a dedicated gateway can be swapped in without a
 * release.
 */
export const DEFAULT_IPFS_GATEWAY = 'https://ipfs.filebase.io/ipfs/';

export function ipfsGateway(): string {
  const configured = process.env.IPFS_GATEWAY_URL?.trim();
  if (!configured) return DEFAULT_IPFS_GATEWAY;
  return configured.endsWith('/') ? configured : `${configured}/`;
}

/** The URL a remote tokenURI is fetched from, or null for a scheme we can't fetch (ar:// etc). */
export function registrationFetchUrl(uri: string, gateway: string = ipfsGateway()): string | null {
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
  if (uri.startsWith('ipfs://')) return gateway + uri.slice('ipfs://'.length).replace(/^ipfs\//, '');
  return null;
}

/**
 * Live fetch for a single agent read. Throws on anything it can't resolve; the
 * callers attach the message as `registrationError`.
 */
export async function fetchRegistration(
  uri: string,
  opts: { ipfsGateway?: string; timeoutMs?: number; fetchJson?: (url: string) => Promise<unknown> } = {},
): Promise<unknown> {
  // data:application/json[;enc=gzip[;level=N]];base64,XXXX — fully on-chain.
  if (uri.startsWith('data:application/json')) return decodeDataUriJson(uri);

  const url = registrationFetchUrl(uri, opts.ipfsGateway ?? ipfsGateway());
  if (!url) throw new Error(`unsupported URI scheme: ${uri.slice(0, 32)}…`);

  // SSRF guard: tokenURIs are attacker-controlled on-chain data — the host and
  // every redirect hop must be public before fetching.
  const fetchJson = opts.fetchJson ?? ((u: string) => safeFetchJson(u, { timeoutMs: opts.timeoutMs ?? 8000 }));
  return fetchJson(url);
}
