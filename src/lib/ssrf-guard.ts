/**
 * SSRF guard for server-side fetches of untrusted URLs (e.g. on-chain
 * tokenURIs, user-declared agent endpoints). Resolves the host and rejects any
 * address in a loopback / private / link-local / special-use range BEFORE a
 * request is issued, re-validating on every redirect hop, and caps the body.
 *
 * Pure (`isPrivateIp`, `assertPublicHttpUrl` with an injected lookup) so the
 * dangerous ranges are unit-testable without real DNS or sockets.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type DnsLookup = (host: string) => Promise<{ address: string; family: number }[]>;

const defaultLookup: DnsLookup = (host) => lookup(host, { all: true });

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

function v4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums as [number, number, number, number];
}

function isPrivateV4(ip: string): boolean {
  const o = v4Octets(ip);
  if (!o) return true; // unparseable → unsafe
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0 && o[2] === 0) return true; // 192.0.0/24 IETF
  if (a === 192 && b === 0 && o[2] === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmark
  if (a === 198 && b === 51 && o[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && o[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast 224/4 + reserved 240/4 + broadcast
  return false;
}

function isPrivateV6(ip: string): boolean {
  const addr = ip.toLowerCase();
  if (addr === '::1' || addr === '::') return true; // loopback / unspecified
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible → judge by the v4 address.
  const mapped = addr.match(/(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  const firstHextet = addr.split(':')[0];
  const head = parseInt(firstHextet || '0', 16);
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/** True for any IP a server should not fetch from. Invalid input → true (fail closed). */
export function isPrivateIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateV4(ip);
  if (family === 6) return isPrivateV6(ip);
  return true;
}

/**
 * Validate that `rawUrl` is http(s) and every address its host resolves to is
 * public. Throws {@link SsrfError} otherwise. Returns the parsed URL.
 */
export async function assertPublicHttpUrl(
  rawUrl: string,
  opts: { lookup?: DnsLookup } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError(`invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`blocked protocol: ${url.protocol}`);
  }
  let host = url.hostname.replace(/\.$/, '').toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // unwrap [ipv6]

  if (isIP(host)) {
    if (isPrivateIp(host)) throw new SsrfError(`blocked private address: ${host}`);
    return url;
  }

  const resolve = opts.lookup ?? defaultLookup;
  let addrs: { address: string }[];
  try {
    addrs = await resolve(host);
  } catch {
    throw new SsrfError(`DNS lookup failed: ${host}`);
  }
  if (addrs.length === 0) throw new SsrfError(`no DNS records: ${host}`);
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new SsrfError(`${host} resolves to private ${a.address}`);
  }
  return url;
}

async function readCappedBytes(res: Response, maxBytes: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.from(await res.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SsrfError(`response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  return (await readCappedBytes(res, maxBytes)).toString('utf-8');
}

/**
 * Fetch JSON from an untrusted URL with SSRF protection: every hop (initial +
 * each redirect) is host-validated before the request, redirects are followed
 * manually, and the body is size-capped. Throws {@link SsrfError} / on bad JSON.
 */
export async function safeFetchJson(
  rawUrl: string,
  opts: {
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    lookup?: DnsLookup;
    headers?: Record<string, string>;
  } = {},
): Promise<unknown> {
  const {
    timeoutMs = 6000,
    maxBytes = 256 * 1024,
    maxRedirects = 3,
    lookup: lookupFn,
    headers = { 'User-Agent': 'AgentKarma/1.0', Accept: 'application/json' },
  } = opts;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await assertPublicHttpUrl(current, { lookup: lookupFn });
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers,
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new SsrfError('redirect without Location header');
      current = new URL(loc, url).toString();
      continue;
    }
    if (!res.ok) throw new SsrfError(`HTTP ${res.status}`);
    return JSON.parse(await readCapped(res, maxBytes));
  }
  throw new SsrfError(`exceeded ${maxRedirects} redirects`);
}

/** A status-bearing probe result. `json` is the parsed body when it parses as
 *  JSON, else null (with the cause in `parseError`). */
export interface SafeFetchResult {
  status: number;
  json: unknown | null;
  parseError?: string;
}

/**
 * SSRF-guarded probe that, unlike {@link safeFetchJson}, does NOT throw on a
 * non-2xx status — it returns the status and the parsed body. This is what the
 * x402 payee discovery needs: a paywalled endpoint answers an unpaid request
 * with HTTP **402** and a JSON `accepts` body, which `safeFetchJson` would
 * reject as `HTTP 402` before the body is read.
 *
 * Same defense as `safeFetchJson`: every hop (initial + each redirect) is
 * host-validated BEFORE the request via {@link assertPublicHttpUrl}, redirects
 * are followed manually, and the body is size-capped. Network / SSRF / redirect
 * failures still throw {@link SsrfError}; a body that isn't valid JSON yields
 * `{ status, json: null, parseError }` rather than throwing, so the caller can
 * still act on the status code.
 */
export async function safeFetchWithStatus(
  rawUrl: string,
  opts: {
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    lookup?: DnsLookup;
    headers?: Record<string, string>;
  } = {},
): Promise<SafeFetchResult> {
  const {
    timeoutMs = 6000,
    maxBytes = 256 * 1024,
    maxRedirects = 3,
    lookup: lookupFn,
    headers = { 'User-Agent': 'AgentKarma/1.0', Accept: 'application/json' },
  } = opts;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await assertPublicHttpUrl(current, { lookup: lookupFn });
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers,
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new SsrfError('redirect without Location header');
      current = new URL(loc, url).toString();
      continue;
    }
    const text = await readCapped(res, maxBytes);
    try {
      return { status: res.status, json: text === '' ? null : JSON.parse(text) };
    } catch (err) {
      return {
        status: res.status,
        json: null,
        parseError: err instanceof Error ? err.message : String(err),
      };
    }
  }
  throw new SsrfError(`exceeded ${maxRedirects} redirects`);
}

/** Raw bytes + declared content type from an SSRF-guarded image fetch. */
export interface SafeImageResult {
  status: number;
  contentType: string | null;
  bytes: Buffer;
}

/**
 * Fetch binary image bytes from an untrusted URL with the same SSRF defense as
 * {@link safeFetchJson}: every hop (initial + each redirect) is host-validated
 * before the request, redirects are followed manually, and the body is
 * size-capped (default 2 MB). The caller is responsible for content-type
 * allow-listing. Throws {@link SsrfError} on a blocked host / non-2xx / oversize.
 */
export async function safeFetchImage(
  rawUrl: string,
  opts: {
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    lookup?: DnsLookup;
  } = {},
): Promise<SafeImageResult> {
  const { timeoutMs = 6000, maxBytes = 2 * 1024 * 1024, maxRedirects = 3, lookup: lookupFn } = opts;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await assertPublicHttpUrl(current, { lookup: lookupFn });
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'AgentKarma/1.0', Accept: 'image/*' },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new SsrfError('redirect without Location header');
      current = new URL(loc, url).toString();
      continue;
    }
    if (!res.ok) throw new SsrfError(`HTTP ${res.status}`);
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      bytes: await readCappedBytes(res, maxBytes),
    };
  }
  throw new SsrfError(`exceeded ${maxRedirects} redirects`);
}
