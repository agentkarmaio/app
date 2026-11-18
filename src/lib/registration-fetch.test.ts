/// <reference types="bun-types" />
/**
 * Live registration fetcher shared by the EVM 8004 read surfaces (Arc mainnet,
 * Arc testnet, Celo). Regression: the live path threw `unsupported URI scheme`
 * on ipfs:// while the registry mirror resolved the same URI, so ipfs-hosted
 * agents were mirror-eligible but live-scored 0 and re-drawn by the Arc drip
 * every day (#2659 in 10 of 14 runs, 2026-11).
 *
 * Run: bun test src/lib/registration-fetch.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { DEFAULT_IPFS_GATEWAY, fetchRegistration, registrationFetchUrl } from './registration-fetch';

const REG = { type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: 'x' };

function recorder() {
  const urls: string[] = [];
  const fetchJson = async (url: string) => {
    urls.push(url);
    return REG;
  };
  return { urls, fetchJson };
}

describe('fetchRegistration', () => {
  test('resolves ipfs:// through the gateway', async () => {
    const { urls, fetchJson } = recorder();
    const reg = await fetchRegistration('ipfs://QmQqK3i4J9teNCzyCoyc4rdWpW7ntx5sV3DycQnwycw2JA', { fetchJson });
    expect(reg).toEqual(REG);
    expect(urls).toEqual([`${DEFAULT_IPFS_GATEWAY}QmQqK3i4J9teNCzyCoyc4rdWpW7ntx5sV3DycQnwycw2JA`]);
  });

  test('strips a redundant ipfs/ path prefix', async () => {
    const { urls, fetchJson } = recorder();
    await fetchRegistration('ipfs://ipfs/QmCid/agent.json', { fetchJson, ipfsGateway: 'https://gw.example/ipfs/' });
    expect(urls).toEqual(['https://gw.example/ipfs/QmCid/agent.json']);
  });

  test('fetches http(s) as-is', async () => {
    const { urls, fetchJson } = recorder();
    await fetchRegistration('https://centralcity.ai/a/YcOuC2', { fetchJson });
    expect(urls).toEqual(['https://centralcity.ai/a/YcOuC2']);
  });

  test('decodes inline data: JSON without a network call', async () => {
    const { urls, fetchJson } = recorder();
    const uri = `data:application/json;base64,${Buffer.from(JSON.stringify(REG)).toString('base64')}`;
    expect(await fetchRegistration(uri, { fetchJson })).toEqual(REG);
    expect(urls).toEqual([]);
  });

  test('still rejects schemes it cannot fetch', async () => {
    const { urls, fetchJson } = recorder();
    await expect(fetchRegistration('ar://abc', { fetchJson })).rejects.toThrow('unsupported URI scheme');
    expect(urls).toEqual([]);
  });
});

describe('registrationFetchUrl', () => {
  test('maps every remote scheme the mirror and live path share', () => {
    expect(registrationFetchUrl('ipfs://QmCid', 'https://gw/ipfs/')).toBe('https://gw/ipfs/QmCid');
    expect(registrationFetchUrl('http://a.example/x', 'https://gw/ipfs/')).toBe('http://a.example/x');
    expect(registrationFetchUrl('ar://abc', 'https://gw/ipfs/')).toBeNull();
  });
});
