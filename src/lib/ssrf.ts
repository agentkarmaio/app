/**
 * SSRF guard for outbound fetches against attacker-controlled URLs.
 *
 * The manifest resolver fetches `{website}/.well-known/agentkarma.json` and
 * GitHub proof files. `website` is declared by the wallet owner and the refresh
 * endpoint is a PUBLIC, unauthenticated POST — so without a guard an attacker
 * can point AgentKarma's server at internal services (cloud metadata at
 * 169.254.169.254, localhost admin panels, RFC1918 hosts) and exfiltrate the
 * response or probe the internal network. See SECURITY.md (manifest-resolver
 * SSRF).
 *
 * Defense:
 *   1. Parse + scheme-check the URL (https-only in production, http allowed in
 *      dev/test for localhost-free fixtures).
 *   2. Resolve the hostname to its A/AAAA records and reject if ANY resolved
 *      address falls in a private / loopback / link-local / CGNAT / ULA /
 *      metadata range. DNS rebinding is mitigated by pinning: we connect to a
 *      vetted IP rather than re-resolving.
 *   3. Follow redirects MANUALLY (`redirect: 'manual'`) and re-run the full
 *      validation on every hop, so a 302 to http://169.254.169.254 is caught.
 *
 * Pure-ish: `assertPublicUrl` does DNS I/O; `isBlockedIp` is pure and unit-
 * testable.
 */

import { lookup } from 'node:dns/promises';
import net from 'node:net';

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

const MAX_REDIRECTS = 4;

/**
 * True when an IP literal (v4 or v6) is in a range we must never fetch from.
 * Covers: loopback, RFC1918 private, link-local (incl. 169.254.169.254 cloud
 * metadata), CGNAT (100.64/10), broadcast/this-host, IPv6 loopback (::1),
 * unique-local (fc00::/7), IPv6 link-local (fe80::/10), and IPv4-mapped IPv6.
 */
export function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  // Not a parseable IP literal — treat as blocked (defensive; callers pass
  // only resolved literals).
  return true;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 special
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240/4 reserved + 255 broadcast
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // Normalize IPv4-mapped / IPv4-compatible (::ffff:a.b.c.d, ::a.b.c.d): if it
  // embeds a v4 literal, validate that v4.
  const v4Embedded = lower.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Embedded) return isBlockedIpv4(v4Embedded[1]);

  if (lower === '::' || lower === '::1') return true; // unspecified + loopback
  const firstHextet = lower.split(':')[0] ?? '';
  const head = parseInt(firstHextet || '0', 16);
  if (Number.isNaN(head)) return true;
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((head & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

interface VettedHost {
  /** Original URL, unchanged. */
  url: URL;
  /** Resolved, vetted IP literal to connect to (DNS-rebinding pin). */
  ip: string;
  family: 4 | 6;
}

/**
 * Validate a URL for outbound fetch. Throws SsrfBlockedError on any violation.
 * Returns the resolved IP so the caller can pin the connection.
 */
export async function assertPublicUrl(rawUrl: string): Promise<VettedHost> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`Unparseable URL: ${rawUrl}`);
  }

  const httpsOnly = process.env.NODE_ENV === 'production';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !httpsOnly)) {
    throw new SsrfBlockedError(`Blocked scheme: ${url.protocol} (https required)`);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  // If the hostname is already an IP literal, validate it directly.
  const literalFamily = net.isIP(hostname);
  if (literalFamily !== 0) {
    if (isBlockedIp(hostname)) {
      throw new SsrfBlockedError(`Blocked IP literal: ${hostname}`);
    }
    return { url, ip: hostname, family: literalFamily as 4 | 6 };
  }

  // Resolve all A/AAAA records; reject if ANY is in a blocked range. We connect
  // to the first allowed record (pinned) to defeat DNS rebinding.
  let records: { address: string; family: number }[];
  try {
    records = await lookup(hostname, { all: true });
  } catch {
    throw new SsrfBlockedError(`DNS resolution failed for ${hostname}`);
  }
  if (records.length === 0) {
    throw new SsrfBlockedError(`No DNS records for ${hostname}`);
  }
  for (const rec of records) {
    if (isBlockedIp(rec.address)) {
      throw new SsrfBlockedError(`Hostname ${hostname} resolves to blocked IP ${rec.address}`);
    }
  }
  const pick = records[0];
  return { url, ip: pick.address, family: pick.family as 4 | 6 };
}

export interface SafeFetchOptions {
  timeoutMs: number;
  maxBodyBytes: number;
  headers?: Record<string, string>;
}

/**
 * SSRF-safe fetch: validates the URL (and every redirect hop) against
 * `assertPublicUrl`, follows redirects manually, and bounds time + body size.
 *
 * Returns the response body text on a 2xx, or null on any non-2xx / blocked /
 * oversized / timed-out outcome (so callers preserve their existing "null means
 * no manifest" semantics). Throws nothing for the caller's hot path EXCEPT it
 * lets SsrfBlockedError surface so the route can log/deny — but the public fetch
 * helpers below swallow it to null to match prior behavior.
 */
export async function safeFetchText(
  rawUrl: string,
  opts: SafeFetchOptions,
): Promise<string | null> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const vetted = await assertPublicUrl(current);

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
    let res: Response;
    try {
      res = await fetch(vetted.url, {
        signal: ctl.signal,
        redirect: 'manual',
        headers: opts.headers,
      });
    } finally {
      clearTimeout(timer);
    }

    // Manual redirect handling — re-validate the next hop.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return null;
      // Resolve relative redirects against the current URL.
      current = new URL(loc, vetted.url).toString();
      continue;
    }

    if (!res.ok) return null;

    const text = await res.text();
    if (text.length > opts.maxBodyBytes) return null;
    return text;
  }
  // Too many redirects.
  return null;
}
