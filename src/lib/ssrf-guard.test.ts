/// <reference types="bun-types" />
/**
 * SSRF guard unit tests — the dangerous-range table and URL validation, with an
 * injected DNS lookup so no real network is touched.
 *
 * Run: bun test src/lib/ssrf-guard.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { isPrivateIp, assertPublicHttpUrl, SsrfError } from './ssrf-guard';

describe('isPrivateIp', () => {
  test.each([
    '0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1',
    '172.31.255.255', '192.168.1.1', '100.64.0.1', '198.18.0.1', '224.0.0.1',
    '255.255.255.255', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip',
  ])('%s is private/unsafe', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  test.each([
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.255.255',
    '11.0.0.1', '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
  ])('%s is public', (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });
});

describe('assertPublicHttpUrl', () => {
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

  test('rejects non-http(s) protocols', async () => {
    await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicHttpUrl('gopher://x/')).rejects.toBeInstanceOf(SsrfError);
  });

  test('rejects private IP literals before any DNS', async () => {
    await expect(assertPublicHttpUrl('http://169.254.169.254/')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicHttpUrl('http://[::1]/')).rejects.toBeInstanceOf(SsrfError);
  });

  test('allows a public IP literal', async () => {
    const u = await assertPublicHttpUrl('https://8.8.8.8/agent.json');
    expect(u.hostname).toBe('8.8.8.8');
  });

  test('rejects a host that resolves only to a private address', async () => {
    await expect(
      assertPublicHttpUrl('http://internal.test/', { lookup: async () => [{ address: '10.0.0.1', family: 4 }] }),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  test('rejects when any resolved address is private (mixed result)', async () => {
    await expect(
      assertPublicHttpUrl('http://rebind.test/', {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
      }),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  test('allows a host that resolves to a public address', async () => {
    const u = await assertPublicHttpUrl('https://example.com/agent.json', { lookup: publicLookup });
    expect(u.hostname).toBe('example.com');
  });

  test('rejects a host with no DNS records', async () => {
    await expect(
      assertPublicHttpUrl('http://void.test/', { lookup: async () => [] }),
    ).rejects.toBeInstanceOf(SsrfError);
  });
});
