/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { getAdapter, getAllAdapters } from './registry';
import { CHAINS } from '@/db/schema';
import { detectChain, resolveChainParam } from '@/lib/chain-detect';

describe('chain-adapter registry', () => {
  test('getAdapter returns the matching adapter for each chain', () => {
    expect(getAdapter('solana').chain).toBe('solana');
    expect(getAdapter('celo').chain).toBe('celo');
    expect(getAdapter('stellar').chain).toBe('stellar');
    expect(getAdapter('arc').chain).toBe('arc');
  });

  test('getAllAdapters covers active chains exactly once and retains explicit archive lookup', () => {
    const chains = getAllAdapters().map((a) => a.chain).sort();
    expect(chains).toEqual(CHAINS.filter((chain) => chain !== 'arc' && chain !== 'stellar-testnet').sort());
  });

  // Mainnet and testnet G-addresses are format-identical. If the testnet adapter
  // joined the fan-out, detectChain would see two matches and return null for
  // EVERY Stellar address, silently breaking mainnet auto-detection.
  test('stellar-testnet resolves only when pinned, never by format', () => {
    const G = 'GC2NIKT6TWLMBZE4TU5ZMMDVV22URFIMJIZ4JYUC3QABBBWNGGZMAFGM';
    expect(getAdapter('stellar-testnet').chain).toBe('stellar-testnet');
    expect(getAdapter('stellar-testnet').validateAddress(G)).toBe(true);
    expect(detectChain(G)).toBe('stellar');
    expect(resolveChainParam('stellar-testnet', G)).toBe('stellar-testnet');
    expect(getAdapter('stellar-testnet').explorerAddressUrl(G)).toContain('/explorer/testnet/');
  });

  test('stellar-testnet adapter never indexes or publishes attestations', async () => {
    const a = getAdapter('stellar-testnet');
    await expect(a.publishAttestation('G', {} as never)).rejects.toThrow('api_only_chain');
    await expect(a.readAttestation('G')).rejects.toThrow('api_only_chain');
    await expect(a.indexReceipts()).rejects.toThrow('api_only_chain');
  });

  test('getAdapter throws on an unknown chain', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => getAdapter('bitcoin' as any)).toThrow('No ChainAdapter for chain: bitcoin');
  });
});
