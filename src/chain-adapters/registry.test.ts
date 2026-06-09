/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { getAdapter, getAllAdapters } from './registry';
import { CHAINS } from '@/db/schema';

describe('chain-adapter registry', () => {
  test('getAdapter returns the matching adapter for each chain', () => {
    expect(getAdapter('solana').chain).toBe('solana');
    expect(getAdapter('celo').chain).toBe('celo');
    expect(getAdapter('stellar').chain).toBe('stellar');
    expect(getAdapter('arc').chain).toBe('arc');
  });

  test('getAllAdapters covers every chain in CHAINS exactly once', () => {
    const chains = getAllAdapters().map((a) => a.chain).sort();
    expect(chains).toEqual([...CHAINS].sort());
  });

  test('getAdapter throws on an unknown chain', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => getAdapter('bitcoin' as any)).toThrow('No ChainAdapter for chain: bitcoin');
  });
});
