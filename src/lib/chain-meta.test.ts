/// <reference types="bun-types" />
/**
 * Unit tests for chain-meta — UI metadata + ordering for the chain switcher.
 * Run: bun test src/lib/chain-meta.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { CHAINS } from '@/db/schema';
import { CHAIN_META, chainOptions, DEFAULT_CHAIN, isAgentPath, agentChainFromPath } from './chain-meta';

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

describe('isAgentPath — switcher must not navigate away from agent detail pages', () => {
  test('true for /agent/<address> and the bare /agent', () => {
    expect(isAgentPath('/agent/0xde65df7ab93a88aa48e6e1d847d718b05721a1bc')).toBe(true);
    expect(isAgentPath('/agent/DexWirjm2hS5ghfS41bLBx7FgaR2Mug9AsstisrT9jpW')).toBe(true);
    expect(isAgentPath('/agent')).toBe(true);
  });

  test('false for browse/landing pages (switcher navigates there as before)', () => {
    expect(isAgentPath('/')).toBe(false);
    expect(isAgentPath('/explore')).toBe(false);
    expect(isAgentPath('/celo')).toBe(false);
    expect(isAgentPath('/agents')).toBe(false); // not the agent detail route
  });
});

describe('agentChainFromPath — seed the switcher from the agent address class', () => {
  test('EVM 0x address seeds an EVM chain (Celo/Arc share the EVM wallet)', () => {
    expect(agentChainFromPath('/agent/0xde65df7ab93a88aa48e6e1d847d718b05721a1bc')).toBe('celo');
  });
  test('Stellar StrKey seeds stellar', () => {
    expect(agentChainFromPath('/agent/GABC234567ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMN')).toBe('stellar');
  });
  test('base58 (Solana) seeds solana', () => {
    expect(agentChainFromPath('/agent/DexWirjm2hS5ghfS41bLBx7FgaR2Mug9AsstisrT9jpW')).toBe('solana');
  });
  test('non-agent path falls back to solana', () => {
    expect(agentChainFromPath('/explore')).toBe('solana');
  });
});
