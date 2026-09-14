import { describe, expect, test } from 'bun:test';
import { CHAINS } from '@/db/schema';
import { explorerAddressUrl, explorerTxUrl } from '@/lib/explorer-urls';

/**
 * These are the exact strings the per-adapter tests assert. Pinning them here
 * as well means a drift in either direction fails the build rather than
 * silently pointing a link at the wrong explorer.
 */
describe('explorerTxUrl', () => {
  test.each([
    ['solana', 'sig', 'https://solscan.io/tx/sig'],
    ['celo', '0xtx', 'https://celoscan.io/tx/0xtx'],
    ['arc', '0xtx', 'https://testnet.arcscan.app/tx/0xtx'],
    ['arc-mainnet', '0xtx', 'https://arc-scan.org/tx/0xtx'],
    ['stellar', 'abc', 'https://stellar.expert/explorer/public/tx/abc'],
  ] as const)('%s', (chain, id, expected) => {
    expect(explorerTxUrl(chain, id)).toBe(expected);
  });
});

describe('explorerAddressUrl', () => {
  test.each([
    ['solana', 'W', 'https://solscan.io/account/W'],
    ['celo', '0xW', 'https://celoscan.io/address/0xW'],
    ['arc', '0xW', 'https://testnet.arcscan.app/address/0xW'],
    ['arc-mainnet', '0xW', 'https://arc-scan.org/address/0xW'],
    ['stellar', 'G', 'https://stellar.expert/explorer/public/account/G'],
  ] as const)('%s', (chain, addr, expected) => {
    expect(explorerAddressUrl(chain, addr)).toBe(expected);
  });
});

test('every chain has an explorer — adding a Chain must not silently yield undefined', () => {
  for (const chain of CHAINS) {
    expect(explorerTxUrl(chain, 'x')).toStartWith('https://');
    expect(explorerAddressUrl(chain, 'x')).toStartWith('https://');
  }
});

/**
 * The Arc entries are hardcoded here rather than read from `@/config/arc-chain`,
 * because that module builds viem chain objects and this one must stay
 * importable from a client bundle. These assertions are what keeps the two
 * honest: if Arc ever changes explorer, the config moves and this fails.
 */
describe('arc explorer bases match the viem chain config', async () => {
  const { arcTestnet, arcMainnet } = await import('@/config/arc-chain');

  test('testnet', () => {
    expect(explorerTxUrl('arc', 'X')).toBe(`${arcTestnet.blockExplorers.default.url}/tx/X`);
    expect(explorerAddressUrl('arc', 'X')).toBe(`${arcTestnet.blockExplorers.default.url}/address/X`);
  });

  test('mainnet', () => {
    expect(explorerTxUrl('arc-mainnet', 'X')).toBe(`${arcMainnet.blockExplorers.default.url}/tx/X`);
    expect(explorerAddressUrl('arc-mainnet', 'X')).toBe(`${arcMainnet.blockExplorers.default.url}/address/X`);
  });
});
