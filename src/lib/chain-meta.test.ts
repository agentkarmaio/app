/// <reference types="bun-types" />
/**
 * Unit tests for chain-meta — UI metadata + ordering for the chain switcher.
 * Run: bun test src/lib/chain-meta.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { CHAINS } from '@/db/schema';
import {
  CHAIN_META,
  chainOptions,
  DEFAULT_CHAIN,
  UI_DEFAULT_CHAIN,
  isAgentPath,
  agentChainFromPath,
  activeChainFromPath,
  registryExplorerLink,
  isEvmChain,
  isRegistryMirrorChain,
} from './chain-meta';

describe('chain-meta', () => {
  test('every CHAINS value has metadata', () => {
    for (const c of CHAINS) {
      expect(CHAIN_META[c]).toBeDefined();
      expect(CHAIN_META[c].label.length).toBeGreaterThan(0);
    }
  });

  test('data-layer default chain stays solana (back-compat)', () => {
    expect(DEFAULT_CHAIN).toBe('solana');
  });

  test('switcher default on chain-neutral pages is stellar', () => {
    expect(UI_DEFAULT_CHAIN).toBe('stellar');
  });

  test('no chain claims the chain-neutral home route', () => {
    for (const c of chainOptions()) {
      expect(CHAIN_META[c].href).not.toBe('/');
    }
  });

  test('chainOptions() lists active networks and preserves the historical schema', () => {
    const opts = chainOptions();
    expect(opts[0]).toBe(UI_DEFAULT_CHAIN);
    expect(opts).toEqual(['stellar', 'solana', 'celo', 'arc-mainnet', 'robinhood']);
    expect(CHAINS).toContain('arc');
    expect(opts).not.toContain('arc');
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

describe('robinhood chain classification', () => {
  test('is EVM (0x addresses, injected-wallet path) and a registry-mirror chain', () => {
    expect(isEvmChain('robinhood')).toBe(true);
    expect(isRegistryMirrorChain('robinhood')).toBe(true);
  });

  test('owns /robinhood as its context page', () => {
    expect(CHAIN_META.robinhood.href).toBe('/robinhood');
    expect(activeChainFromPath('/robinhood')).toBe('robinhood');
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

describe('activeChainFromPath — what the header switcher reads on browse pages', () => {
  test('each chain context page resolves to its own chain', () => {
    expect(activeChainFromPath('/solana')).toBe('solana');
    expect(activeChainFromPath('/celo')).toBe('celo');
    expect(activeChainFromPath('/stellar')).toBe('stellar');
    expect(activeChainFromPath('/arc')).toBe('arc');
    expect(activeChainFromPath('/arc/mainnet')).toBe('arc-mainnet');
    expect(activeChainFromPath('/arc/archive')).toBe('arc');
  });

  test('nested routes under a context page keep that chain', () => {
    expect(activeChainFromPath('/solana/anything')).toBe('solana');
  });

  test('chain-neutral pages fall back to the UI default (stellar)', () => {
    expect(activeChainFromPath('/')).toBe(UI_DEFAULT_CHAIN);
    expect(activeChainFromPath('/explore')).toBe(UI_DEFAULT_CHAIN);
    expect(activeChainFromPath('/protocol')).toBe(UI_DEFAULT_CHAIN);
  });

  test('a path that merely starts with a chain href string is not a match', () => {
    expect(activeChainFromPath('/solanaphobia')).toBe(UI_DEFAULT_CHAIN);
  });
});

describe('registryExplorerLink', () => {
  // Formats verified against the live explorers on 2026-11-19 by page CONTENT
  // (8004scan answers 200 for any path): AgentKarma is celo/9058, arc/228 and
  // stellar8004 #66. The old `8004scan.io/agent/{id}` form 404s for every chain.
  test('celo and arc mainnet use 8004scan network-scoped paths', () => {
    expect(registryExplorerLink('celo', 9058)).toEqual({ url: 'https://8004scan.io/agents/celo/9058', label: '8004scan.io/agents/celo/9058' });
    expect(registryExplorerLink('arc-mainnet', 228)).toEqual({ url: 'https://8004scan.io/agents/arc/228', label: '8004scan.io/agents/arc/228' });
  });

  // Verified 2026-11-24 by content: /agents/robinhood-chain/26469 renders
  // "Agent #26469"; a missing id renders "Agent Not Found". Other slugs 404.
  test('robinhood uses the 8004scan robinhood-chain slug', () => {
    expect(registryExplorerLink('robinhood', 26469)).toEqual({ url: 'https://8004scan.io/agents/robinhood-chain/26469', label: '8004scan.io/agents/robinhood-chain/26469' });
    expect(registryExplorerLink('robinhood', 0)).toEqual({ url: 'https://8004scan.io/agents/robinhood-chain/0', label: '8004scan.io/agents/robinhood-chain/0' });
  });

  test('stellar uses the stellar-8004 explorer — 8004scan does not index Soroban', () => {
    expect(registryExplorerLink('stellar', 66)).toEqual({ url: 'https://stellar8004.com/agents/66', label: 'stellar8004.com/agents/66' });
  });

  test('chains without a verified explorer page return null instead of a dead link', () => {
    expect(registryExplorerLink('solana', 1)).toBeNull();
    expect(registryExplorerLink('arc', 1)).toBeNull();
    expect(registryExplorerLink('stellar-testnet', 1)).toBeNull();
  });

  test('rejects a non-integer agentId', () => {
    expect(registryExplorerLink('celo', Number.NaN)).toBeNull();
    expect(registryExplorerLink('celo', -1)).toBeNull();
  });
});
