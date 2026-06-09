/// <reference types="bun-types" />
/**
 * Unit tests for chain-meta — UI metadata + ordering for the chain switcher.
 * Run: bun test src/lib/chain-meta.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { CHAINS } from '@/db/schema';
import { CHAIN_META, chainOptions, DEFAULT_CHAIN } from './chain-meta';

describe('chain-meta', () => {
  test('every CHAINS value has metadata', () => {
    for (const c of CHAINS) {
      expect(CHAIN_META[c]).toBeDefined();
      expect(CHAIN_META[c].label.length).toBeGreaterThan(0);
    }
  });

  test('default chain is solana (per spec: Solana default)', () => {
    expect(DEFAULT_CHAIN).toBe('solana');
  });

  test('chainOptions() lists solana first, then the rest in CHAINS order', () => {
    const opts = chainOptions();
    expect(opts[0]).toBe('solana');
    expect(opts).toEqual([...CHAINS]);
    expect(new Set(opts).size).toBe(opts.length); // no dupes
  });

  test('each option carries an href used by the switcher', () => {
    for (const c of chainOptions()) {
      expect(CHAIN_META[c].href).toMatch(/^\//);
    }
  });

  test('each option carries a brand-mark logo path', () => {
    for (const c of chainOptions()) {
      expect(CHAIN_META[c].logo).toMatch(/^\/logos\/.+\.svg$/);
    }
  });
});
