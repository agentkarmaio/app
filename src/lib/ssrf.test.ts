/// <reference types="bun-types" />
/**
 * SSRF guard unit tests — the security-critical pure logic.
 *
 * Run: bun test src/lib/ssrf.test.ts
 *
 * Covers isBlockedIp range classification (the heart of the guard) and the
 * synchronous parts of assertPublicUrl (scheme + IP-literal rejection) which
 * need no DNS. Hostname-resolution + redirect-hop revalidation are integration
 * concerns exercised via the manifest resolver.
 */

import { describe, expect, test } from 'bun:test';
import { isBlockedIp, assertPublicUrl, SsrfBlockedError } from './ssrf';

describe('isBlockedIp — IPv4 ranges', () => {
  const BLOCKED = [
    '127.0.0.1',        // loopback
    '127.0.0.53',       // loopback
    '0.0.0.0',          // this-host
    '10.0.0.1',         // RFC1918
    '10.255.255.255',
    '172.16.0.1',       // RFC1918
    '172.31.255.255',
    '192.168.1.1',      // RFC1918
    '169.254.169.254',  // cloud metadata (the headline target)
    '169.254.0.1',      // link-local
    '100.64.0.1',       // CGNAT
    '100.127.255.255',
    '224.0.0.1',        // multicast
    '255.255.255.255',  // broadcast
    '192.0.2.1',        // TEST-NET / special
  ];
  for (const ip of BLOCKED) {
    test(`blocks ${ip}`, () => expect(isBlockedIp(ip)).toBe(true));
  }

  const ALLOWED = [
    '8.8.8.8',          // public DNS
    '1.1.1.1',
    '93.184.216.34',    // example.com
    '172.32.0.1',       // just outside 172.16/12
    '172.15.255.255',   // just below 172.16/12
    '100.63.255.255',   // just below CGNAT
    '100.128.0.1',      // just above CGNAT
    '11.0.0.1',         // outside 10/8
  ];
  for (const ip of ALLOWED) {
    test(`allows ${ip}`, () => expect(isBlockedIp(ip)).toBe(false));
  }
});

describe('isBlockedIp — IPv6 ranges', () => {
  const BLOCKED = [
    '::1',              // loopback
    '::',              // unspecified
    'fc00::1',          // unique-local
    'fd12:3456::1',     // unique-local
    'fe80::1',          // link-local
    'ff02::1',          // multicast
    '::ffff:127.0.0.1', // v4-mapped loopback
    '::ffff:169.254.169.254', // v4-mapped metadata
  ];
  for (const ip of BLOCKED) {
    test(`blocks ${ip}`, () => expect(isBlockedIp(ip)).toBe(true));
  }

  const ALLOWED = [
    '2001:4860:4860::8888', // Google public DNS v6
    '2606:2800:220:1::1',   // public
    '::ffff:8.8.8.8',       // v4-mapped public
  ];
  for (const ip of ALLOWED) {
    test(`allows ${ip}`, () => expect(isBlockedIp(ip)).toBe(false));
  }
});

describe('isBlockedIp — non-IP input', () => {
  test('blocks garbage (defensive)', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
    expect(isBlockedIp('')).toBe(true);
  });
});

describe('assertPublicUrl — scheme + literal gating', () => {
  test('rejects loopback IP literal without DNS', async () => {
    await expect(assertPublicUrl('http://127.0.0.1/x')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  test('rejects metadata IP literal', async () => {
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  test('rejects bracketed IPv6 loopback literal', async () => {
    await expect(assertPublicUrl('http://[::1]:8080/')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  test('rejects unparseable URL', async () => {
    await expect(assertPublicUrl('::::not a url')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  test('rejects non-http(s) scheme', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicUrl('ftp://example.com/x')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  test('allows a public IP literal over http (dev)', async () => {
    // NODE_ENV is "test" here, so http is permitted; 8.8.8.8 is public.
    const vetted = await assertPublicUrl('http://8.8.8.8/');
    expect(vetted.ip).toBe('8.8.8.8');
    expect(vetted.family).toBe(4);
  });
});
