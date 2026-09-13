import { describe, expect, test } from 'bun:test';
import { arcMainnet, arcTestnet } from './arc-chain';
import { parseArcMainnetRpcUrl, parseArcMainnetStartBlock, parseArcMainnetSeedAddresses } from './arc-mainnet';

describe('Arc mainnet configuration is explicit', () => {
  test('operator seed configuration is mainnet-only, deduplicated, and rejects invalid addresses', () => {
    const address = '0x558e7bfaf2cf1a494f44e50d92431afc060c9d12';
    expect(parseArcMainnetSeedAddresses(undefined)).toEqual([]);
    expect(parseArcMainnetSeedAddresses(`${address}, ${address}`)).toEqual([address]);
    expect(() => parseArcMainnetSeedAddresses(`${address},invalid`)).toThrow('arc_mainnet_seed_invalid');
  });
  test('keeps network identities distinct and supplies no default mainnet RPC', () => {
    expect(arcMainnet.id).toBe(5042);
    expect(arcTestnet.id).toBe(5042002);
    expect(arcMainnet.rpcUrls.default.http).toEqual([]);
  });
  test('requires full HTTPS without leaking the supplied configuration in errors', () => {
    for (const value of [undefined, '', 'provider.invalid/SECRET', 'http://provider.invalid/SECRET', 'https://user:SECRET@provider.invalid', 'https://provider.invalid/#SECRET']) {
      try { parseArcMainnetRpcUrl(value); throw Error('expected rejection'); }
      catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toContain('SECRET');
        expect((error as Error).message).toMatch(/^arc_mainnet_rpc_/);
      }
    }
    expect(parseArcMainnetRpcUrl('https://provider.invalid/v1/key')).toBe('https://provider.invalid/v1/key');
  });
  test('rejects partial or unsafe start blocks instead of silently choosing another block', () => {
    expect(parseArcMainnetStartBlock(undefined)).toBe(0);
    expect(parseArcMainnetStartBlock('24')).toBe(24);
    for (const value of ['24junk', '-1', '1.5', '9007199254740992']) expect(() => parseArcMainnetStartBlock(value)).toThrow('arc_mainnet_start_invalid');
  });
});
