/// <reference types="bun-types" />
/**
 * Unit tests for Stellar x402 config (U2).
 * Run: bun test src/config/stellar-x402.test.ts
 */

import { describe, expect, test } from 'bun:test';
import {
  USDC_SAC,
  STELLAR_USDC_DECIMALS,
  STELLAR_G_ADDRESS_RE,
  STELLAR_C_ADDRESS_RE,
  getStellarUsdcSac,
  isStellarAccount,
  isStellarContract,
  STELLAR_FACILITATORS,
  STELLAR_FACILITATOR_SET,
  STELLAR_MPP_RECIPIENTS,
} from './stellar-x402';

const G = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'; // USDC testnet issuer
const C = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'; // USDC pubnet SAC

describe('stellar address regexes', () => {
  test('G regex matches a valid 56-char account', () => {
    expect(STELLAR_G_ADDRESS_RE.test(G)).toBe(true);
    expect(isStellarAccount(G)).toBe(true);
  });

  test('G regex rejects a C-prefixed contract', () => {
    expect(STELLAR_G_ADDRESS_RE.test(C)).toBe(false);
    expect(isStellarAccount(C)).toBe(false);
  });

  test('C regex matches a valid 56-char contract', () => {
    expect(STELLAR_C_ADDRESS_RE.test(C)).toBe(true);
    expect(isStellarContract(C)).toBe(true);
  });

  test('C regex rejects a G-prefixed account', () => {
    expect(STELLAR_C_ADDRESS_RE.test(G)).toBe(false);
    expect(isStellarContract(G)).toBe(false);
  });

  test('rejects wrong length and lowercase / base32-illegal chars', () => {
    expect(STELLAR_G_ADDRESS_RE.test('G123')).toBe(false);
    expect(STELLAR_G_ADDRESS_RE.test(G.toLowerCase())).toBe(false);
    // 0, 1, 8, 9 are not in base32 alphabet A-Z2-7
    expect(STELLAR_G_ADDRESS_RE.test('G' + '0'.repeat(55))).toBe(false);
  });
});

describe('USDC SAC + decimals', () => {
  test('decimals constant is 7', () => {
    expect(STELLAR_USDC_DECIMALS).toBe(7);
  });

  test('getStellarUsdcSac returns pubnet/testnet SAC', () => {
    expect(getStellarUsdcSac('pubnet')).toBe(USDC_SAC.pubnet);
    expect(getStellarUsdcSac('testnet')).toBe(USDC_SAC.testnet);
    expect(getStellarUsdcSac('pubnet')).toBe(C);
  });

  test('both USDC SAC addresses are well-formed C-contracts', () => {
    expect(STELLAR_C_ADDRESS_RE.test(USDC_SAC.pubnet)).toBe(true);
    expect(STELLAR_C_ADDRESS_RE.test(USDC_SAC.testnet)).toBe(true);
  });
});

describe('facilitator + MPP recipient sets (documented-empty Phase 0)', () => {
  test('STELLAR_FACILITATORS starts empty until the OZ Channels G... is probed', () => {
    expect(STELLAR_FACILITATORS).toEqual([]);
    expect(STELLAR_FACILITATOR_SET.size).toBe(0);
  });

  test('STELLAR_FACILITATOR_SET is a membership set built from facilitator accounts', () => {
    expect(STELLAR_FACILITATOR_SET.has(G)).toBe(false);
  });

  test('STELLAR_MPP_RECIPIENTS starts empty until seeded from pay.sh', () => {
    expect(STELLAR_MPP_RECIPIENTS.size).toBe(0);
    expect(STELLAR_MPP_RECIPIENTS.has(G)).toBe(false);
  });
});
