/// <reference types="bun-types" />
/**
 * Config invariants for the Stellar 8004 client.
 *
 * Pinned mainnet contract IDs (D1: adopt trionlabs/stellar-8004), RPC URL
 * resolution, network passphrase, USDC decimals, and the WASM-SHA256 pinning
 * guard (Correction C4 — supply-chain review gate for a days-old single-org
 * dependency).
 *
 * Run: bun test src/integrations/stellar-config.test.ts
 */
import { describe, expect, test } from 'bun:test';
import {
  STELLAR_IDENTITY_REGISTRY,
  STELLAR_REPUTATION_REGISTRY,
  STELLAR_VALIDATION_REGISTRY,
  STELLAR_NETWORK_PASSPHRASE,
  STELLAR_WASM_SHA256,
  USDC_DECIMALS,
  resolveStellarRpcUrl,
  assertPinnedWasm,
} from './stellar-config';

const CONTRACT_RE = /^C[A-Z2-7]{55}$/;

describe('stellar-config', () => {
  test('pinned mainnet contract IDs are valid StrKey contract addresses', () => {
    for (const id of [
      STELLAR_IDENTITY_REGISTRY,
      STELLAR_REPUTATION_REGISTRY,
      STELLAR_VALIDATION_REGISTRY,
    ]) {
      expect(id).toMatch(CONTRACT_RE);
    }
  });

  test('pinned IDs match trionlabs/stellar-8004 MAINNET_CONFIG', () => {
    expect(STELLAR_IDENTITY_REGISTRY).toBe('CBGPDCJIHQ32G42BE7F2CIT3YW6XRN5ED6GQJHCRZSNAYH6TGMCL6X35');
    expect(STELLAR_REPUTATION_REGISTRY).toBe('CBOIAIMMWAXI57OATLX6BWVDQLCC4YU55HV6MZXFRP6CBSGAMXSTEPPA');
    expect(STELLAR_VALIDATION_REGISTRY).toBe('CBT6WWEVEPT2UFGFGVJJ7ELYGLQAGRYSVGDTGMCJTRWXOH27MWUO7UJG');
  });

  test('USDC has 7 decimals; passphrase is PUBLIC', () => {
    expect(USDC_DECIMALS).toBe(7);
    expect(STELLAR_NETWORK_PASSPHRASE).toContain('Public Global Stellar Network');
  });

  test('resolveStellarRpcUrl prefers env, falls back to mainnet default', () => {
    expect(resolveStellarRpcUrl({ STELLAR_RPC_URL: 'https://custom.rpc' })).toBe('https://custom.rpc');
    expect(resolveStellarRpcUrl({})).toBe('https://mainnet.sorobanrpc.com');
  });
});

describe('STELLAR_WASM_SHA256 pinning guard (C4)', () => {
  test('a pin slot exists for each of the three registries', () => {
    expect(STELLAR_WASM_SHA256).toHaveProperty('identity');
    expect(STELLAR_WASM_SHA256).toHaveProperty('reputation');
    expect(STELLAR_WASM_SHA256).toHaveProperty('validation');
  });

  test('assertPinnedWasm is a no-op when the configured hash is empty (unset)', async () => {
    let fetched = 0;
    const res = await assertPinnedWasm('identity', {
      pinned: '',
      fetchLiveHash: async () => { fetched++; return 'anything'; },
    });
    // Empty pin → never fetches, never throws, reports skipped.
    expect(fetched).toBe(0);
    expect(res.skipped).toBe(true);
    expect(res.matched).toBe(false);
  });

  test('assertPinnedWasm passes when a configured hash matches the live fetch', async () => {
    const res = await assertPinnedWasm('identity', {
      pinned: 'deadbeef',
      fetchLiveHash: async () => 'deadbeef',
    });
    expect(res.skipped).toBe(false);
    expect(res.matched).toBe(true);
  });

  test('assertPinnedWasm THROWS when a configured hash mismatches (review gate)', async () => {
    await expect(
      assertPinnedWasm('reputation', {
        pinned: 'aaaa1111',
        fetchLiveHash: async () => 'bbbb2222',
      }),
    ).rejects.toThrow(/WASM hash mismatch/i);
  });

  test('assertPinnedWasm comparison is case-insensitive and trims', async () => {
    const res = await assertPinnedWasm('validation', {
      pinned: '  ABCDEF12  ',
      fetchLiveHash: async () => 'abcdef12',
    });
    expect(res.matched).toBe(true);
  });
});
