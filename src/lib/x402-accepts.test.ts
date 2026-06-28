/// <reference types="bun-types" />
/**
 * Pure-parser tests for the x402 402-body → Celo payee extractor.
 *
 * Covers the acceptance rules and every rejection path the self-seeder relies
 * on: non-Celo network, unknown asset, malformed body, bad payTo. No IO.
 *
 * Run: bun test src/lib/x402-accepts.test.ts
 */

import { describe, expect, test } from 'bun:test';
import {
  extractCeloPayees,
  isCeloNetwork,
  resolveCeloAsset,
  CELO_CHAIN_ID,
} from './x402-accepts';
import { CELO_X402_TOKENS } from '../config/celo-x402';

const USDC = CELO_X402_TOKENS.find((t) => t.symbol === 'USDC')!;
const USDT = CELO_X402_TOKENS.find((t) => t.symbol === 'USDT')!;
const PAYEE = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
const PAYEE_LC = PAYEE.toLowerCase() as `0x${string}`;

function accepts(entries: unknown[]): unknown {
  return { x402Version: 2, error: 'Payment required', accepts: entries };
}

// ── isCeloNetwork ─────────────────────────────────────────────────────────────

describe('isCeloNetwork', () => {
  test('accepts CAIP-2 eip155:42220', () => {
    expect(isCeloNetwork(`eip155:${CELO_CHAIN_ID}`)).toBe(true);
    expect(isCeloNetwork('eip155:42220')).toBe(true);
  });
  test('accepts legacy string aliases (case-insensitive)', () => {
    expect(isCeloNetwork('celo')).toBe(true);
    expect(isCeloNetwork('Celo')).toBe(true);
    expect(isCeloNetwork('celo-mainnet')).toBe(true);
    expect(isCeloNetwork('  CELO  ')).toBe(true);
  });
  test('rejects non-Celo networks', () => {
    expect(isCeloNetwork('eip155:8453')).toBe(false); // Base
    expect(isCeloNetwork('eip155:84532')).toBe(false); // Base Sepolia
    expect(isCeloNetwork('base-sepolia')).toBe(false);
    expect(isCeloNetwork('solana')).toBe(false);
    expect(isCeloNetwork('arc')).toBe(false);
  });
  test('rejects non-string', () => {
    expect(isCeloNetwork(42220)).toBe(false);
    expect(isCeloNetwork(null)).toBe(false);
    expect(isCeloNetwork(undefined)).toBe(false);
  });
});

// ── resolveCeloAsset ──────────────────────────────────────────────────────────

describe('resolveCeloAsset', () => {
  test('resolves a known Celo stablecoin contract address (any case)', () => {
    expect(resolveCeloAsset(USDC.address)?.symbol).toBe('USDC');
    expect(resolveCeloAsset(USDC.address.toLowerCase())?.symbol).toBe('USDC');
    expect(resolveCeloAsset(USDC.address.toUpperCase().replace('0X', '0x'))?.symbol).toBe('USDC');
    expect(resolveCeloAsset(USDT.address)?.symbol).toBe('USDT');
  });
  test('resolves a bare symbol (case-insensitive)', () => {
    expect(resolveCeloAsset('USDC')?.symbol).toBe('USDC');
    expect(resolveCeloAsset('usdc')?.symbol).toBe('USDC');
    expect(resolveCeloAsset('USDm')?.symbol).toBe('USDm');
  });
  test('rejects unknown asset address', () => {
    expect(resolveCeloAsset('0x1234567890123456789012345678901234567890')).toBeNull();
  });
  test('rejects unknown symbol', () => {
    expect(resolveCeloAsset('cUSD')).toBeNull(); // explicitly NOT in the x402 allowlist
    expect(resolveCeloAsset('DAI')).toBeNull();
  });
  test('rejects non-string / empty', () => {
    expect(resolveCeloAsset(null)).toBeNull();
    expect(resolveCeloAsset(123)).toBeNull();
    expect(resolveCeloAsset('')).toBeNull();
    expect(resolveCeloAsset('   ')).toBeNull();
  });
});

// ── extractCeloPayees — happy paths ───────────────────────────────────────────

describe('extractCeloPayees — accepts', () => {
  test('extracts payTo from a v2 CAIP-2 + asset-address entry', () => {
    const body = accepts([
      {
        scheme: 'exact',
        network: 'eip155:42220',
        amount: '10000',
        asset: USDC.address,
        payTo: PAYEE,
        maxTimeoutSeconds: 60,
      },
    ]);
    const out = extractCeloPayees(body);
    expect(out.length).toBe(1);
    expect(out[0].payTo).toBe(PAYEE_LC); // lowercased
    expect(out[0].token.symbol).toBe('USDC');
    expect(out[0].network).toBe('eip155:42220');
    expect(out[0].asset).toBe(USDC.address);
  });

  test('extracts from a v1 legacy entry (maxAmountRequired + symbol asset + string network)', () => {
    const body = accepts([
      {
        scheme: 'exact',
        network: 'celo',
        maxAmountRequired: '1000',
        asset: 'USDC',
        resource: '/api/premium',
        payTo: PAYEE,
      },
    ]);
    const out = extractCeloPayees(body);
    expect(out.length).toBe(1);
    expect(out[0].payTo).toBe(PAYEE_LC);
    expect(out[0].token.symbol).toBe('USDC');
  });

  test('extracts multiple distinct payees across entries', () => {
    const PAYEE2 = '0x1111111111111111111111111111111111111111' as `0x${string}`;
    const body = accepts([
      { network: 'eip155:42220', asset: USDC.address, payTo: PAYEE },
      { network: 'celo', asset: USDT.address, payTo: PAYEE2 },
    ]);
    const out = extractCeloPayees(body);
    expect(out.length).toBe(2);
    expect(out.map((p) => p.payTo).sort()).toEqual([PAYEE_LC, PAYEE2].sort());
  });

  test('de-dupes identical (payTo, asset) across entries', () => {
    const body = accepts([
      { network: 'eip155:42220', asset: USDC.address, payTo: PAYEE },
      { network: 'celo', asset: 'USDC', payTo: PAYEE.toLowerCase() }, // same payee+token
    ]);
    const out = extractCeloPayees(body);
    expect(out.length).toBe(1);
  });

  test('same payee, different token → two rows (distinct keys)', () => {
    const body = accepts([
      { network: 'eip155:42220', asset: USDC.address, payTo: PAYEE },
      { network: 'eip155:42220', asset: USDT.address, payTo: PAYEE },
    ]);
    const out = extractCeloPayees(body);
    expect(out.length).toBe(2);
    expect(new Set(out.map((p) => p.token.symbol))).toEqual(new Set(['USDC', 'USDT']));
  });
});

// ── extractCeloPayees — rejections ────────────────────────────────────────────

describe('extractCeloPayees — rejects', () => {
  test('rejects non-Celo network', () => {
    const body = accepts([{ network: 'eip155:8453', asset: USDC.address, payTo: PAYEE }]);
    expect(extractCeloPayees(body)).toEqual([]);
  });

  test('rejects unknown asset (cUSD / arbitrary contract)', () => {
    expect(extractCeloPayees(accepts([{ network: 'celo', asset: 'cUSD', payTo: PAYEE }]))).toEqual([]);
    expect(
      extractCeloPayees(accepts([{ network: 'celo', asset: '0xdeadbeef00000000000000000000000000000000', payTo: PAYEE }])),
    ).toEqual([]);
  });

  test('rejects malformed payTo', () => {
    expect(extractCeloPayees(accepts([{ network: 'celo', asset: 'USDC', payTo: 'not-an-address' }]))).toEqual([]);
    expect(extractCeloPayees(accepts([{ network: 'celo', asset: 'USDC', payTo: '0x123' }]))).toEqual([]);
    expect(extractCeloPayees(accepts([{ network: 'celo', asset: 'USDC' }]))).toEqual([]); // missing payTo
    expect(extractCeloPayees(accepts([{ network: 'celo', asset: 'USDC', payTo: 42 }]))).toEqual([]);
  });

  test('rejects malformed bodies', () => {
    expect(extractCeloPayees(null)).toEqual([]);
    expect(extractCeloPayees(undefined)).toEqual([]);
    expect(extractCeloPayees('not json')).toEqual([]);
    expect(extractCeloPayees(42)).toEqual([]);
    expect(extractCeloPayees({})).toEqual([]); // no accepts
    expect(extractCeloPayees({ accepts: 'nope' })).toEqual([]); // accepts not array
    expect(extractCeloPayees({ accepts: [null, 'x', 42] })).toEqual([]); // junk entries
  });

  test('mixed valid + invalid entries → only the valid one survives', () => {
    const body = accepts([
      { network: 'eip155:8453', asset: USDC.address, payTo: PAYEE }, // wrong chain
      { network: 'celo', asset: 'cUSD', payTo: PAYEE }, // wrong asset
      { network: 'eip155:42220', asset: USDC.address, payTo: PAYEE }, // valid
    ]);
    const out = extractCeloPayees(body);
    expect(out.length).toBe(1);
    expect(out[0].payTo).toBe(PAYEE_LC);
  });
});
