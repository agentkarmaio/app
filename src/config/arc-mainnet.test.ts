import { describe, expect, test } from 'bun:test';
import { arcMainnet, arcTestnet } from './arc-chain';
import { parseArcMainnetRpcUrl, parseArcMainnetStartBlock, parseArcMainnetSeedAddresses } from './arc-mainnet';
import { getRegistryConfig } from './erc8004-registries';
import { INDEXING_PATHS } from '@/lib/indexing-health';

describe('Arc mainnet configuration is explicit', () => {
  test('schedules the independently configured mainnet registry', () => {
    const config = getRegistryConfig('arc-mainnet');
    expect(config?.chain).toBe('arc-mainnet');
    expect(config?.viemChain.id).toBe(5042);
    expect(config?.rpcEnvVar).toBe('ARC_MAINNET_RPC_URL');
    expect(config?.viemChain.contracts?.multicall3?.address.toLowerCase()).toBe('0xca11bde05977b3631167028862be2a173976ca11');
    expect(INDEXING_PATHS.some(path => path.chain === 'arc-mainnet' && path.path === 'registry')).toBe(true);
    expect(getRegistryConfig('arc')?.viemChain.id).toBe(5042002);
  });
  test('operator seed configuration is mainnet-only, deduplicated, and rejects invalid addresses', () => {
    const address = '0x558e7bfaf2cf1a494f44e50d92431afc060c9d12';
    expect(parseArcMainnetSeedAddresses(undefined)).toEqual([]);
    expect(parseArcMainnetSeedAddresses(`${address}, ${address}`)).toEqual([address]);
    expect(() => parseArcMainnetSeedAddresses(`${address},invalid`)).toThrow('arc_mainnet_seed_invalid');
  });
  test('keeps network identities distinct and supplies no default mainnet RPC', () => {
    expect(arcMainnet.id).toBe(5042);
    expect(arcMainnet.blockExplorers.default.url).toBe('https://explorer.arc.io');
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
