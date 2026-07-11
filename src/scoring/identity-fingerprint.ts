/**
 * Templated-identity detection — Sybil-adjacent bulk-mint fingerprint.
 *
 * See project_arc_registry_synthetic memory: Arc Testnet's bulk-minted
 * IdentityRegistry (~845k ids) includes a farmed range whose on-chain `data:`
 * JSON `name` is auto-generated from the owner address at mint time —
 * "Trader-Bf70ab", "Bridge-21De32" — literally `<Role>-<6 hex chars>`. A
 * counterparty presenting this shape is not an independent identity and must
 * never count toward settlement-quality's distinct-counterparty gate.
 *
 * Deliberately narrow: only detects the ONE concretely-documented name-template
 * shape from a single tokenURI. Does NOT detect the OTHER farmed pattern in the
 * same memory (many distinct agentIds sharing one identical IPFS CID) — that
 * requires comparing across a corpus of agents, not a single tokenURI in
 * isolation, and is out of scope here.
 *
 * Pure + synchronous: only decodes `data:application/json...` URIs already in
 * hand. http(s)/ipfs tokenURIs return false (unflagged) rather than fetching —
 * keeps this usable inline in the indexer without a network round-trip.
 */

import { gunzipSync } from 'node:zlib';

/** `<Role>-<6 hex chars>`, e.g. "Trader-Bf70ab", "Bridge-21De32". Case-insensitive hex. */
const TEMPLATE_NAME_PATTERN = /^[A-Za-z]+-[0-9a-f]{6}$/i;

function decodeDataUri(uri: string): unknown {
  const commaIdx = uri.indexOf(',');
  if (commaIdx < 0) return null;
  const header = uri.slice(5, commaIdx); // strip 'data:'
  const body = uri.slice(commaIdx + 1);
  const params = header.split(';');
  const isBase64 = params.includes('base64');
  const isGzip = params.some((p) => p.startsWith('enc=gzip'));

  let buf: Buffer;
  try {
    buf = isBase64 ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf-8');
    if (isGzip) buf = gunzipSync(buf);
    return JSON.parse(buf.toString('utf-8'));
  } catch {
    return null;
  }
}

/**
 * True when a tokenURI's on-chain metadata `name` matches the documented
 * bulk-mint template shape. Never throws — malformed/unsupported input (and
 * any non-`data:` URI) reads as "not flagged", not an error.
 */
export function isTemplatedIdentity(tokenURI: string | null | undefined): boolean {
  if (!tokenURI || !tokenURI.startsWith('data:application/json')) return false;
  const decoded = decodeDataUri(tokenURI);
  if (typeof decoded !== 'object' || decoded === null) return false;
  const name = (decoded as { name?: unknown }).name;
  return typeof name === 'string' && TEMPLATE_NAME_PATTERN.test(name);
}
