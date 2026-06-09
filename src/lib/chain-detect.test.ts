/// <reference types="bun-types" />
/**
 * Unit tests for chain detection / dispatch.
 *
 * Run: bun test src/lib/chain-detect.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { detectChain, resolveChainParam, isRecognizedAddress } from './chain-detect';

// Real addresses, format-valid for each chain's validateAddress.
const SOLANA = '3rGu9hPHdgwR8KeZTpPkN4Z5VRBeR3LBs9CAnqJ7yDjZ'; // base58, 44 chars
const STELLAR = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'; // StrKey G..., 56 chars
const EVM = '0x8004A818BFB912233c491871b3d84c89A494BD9e'; // 0x…40hex — Celo AND Arc
const JUNK = 'not-a-wallet';

describe('detectChain', () => {
  test('Solana base58 address → solana', () => {
    expect(detectChain(SOLANA)).toBe('solana');
  });

  test('Stellar G-address → stellar', () => {
    expect(detectChain(STELLAR)).toBe('stellar');
  });

  test('EVM 0x address → null (Celo and Arc share the format — ambiguous, needs a pin)', () => {
    expect(detectChain(EVM)).toBeNull();
  });

  test('unrecognized string → null', () => {
    expect(detectChain(JUNK)).toBeNull();
  });

  test('empty string → null', () => {
    expect(detectChain('')).toBeNull();
  });
});

describe('isRecognizedAddress', () => {
  test('accepts every chain format incl. an unpinned EVM address', () => {
    expect(isRecognizedAddress(SOLANA)).toBe(true);
    expect(isRecognizedAddress(STELLAR)).toBe(true);
    expect(isRecognizedAddress(EVM)).toBe(true); // valid even though chain-ambiguous
  });
  test('rejects junk + empty', () => {
    expect(isRecognizedAddress(JUNK)).toBe(false);
    expect(isRecognizedAddress('')).toBe(false);
  });
});

describe('resolveChainParam', () => {
  test('no param: falls back to address detection', () => {
    expect(resolveChainParam(null, STELLAR)).toBe('stellar');
  });

  test('explicit valid chain param wins when address matches that chain', () => {
    expect(resolveChainParam('stellar', STELLAR)).toBe('stellar');
  });

  test('explicit chain param that the address fails → null (mismatch rejected)', () => {
    expect(resolveChainParam('stellar', SOLANA)).toBeNull();
  });

  test('unknown chain param → null', () => {
    expect(resolveChainParam('ethereum', STELLAR)).toBeNull();
  });

  test('no param + junk address → null', () => {
    expect(resolveChainParam(null, JUNK)).toBeNull();
  });

  test('EVM address: explicit pin resolves, no pin is null (Celo/Arc ambiguous)', () => {
    expect(resolveChainParam('arc', EVM)).toBe('arc');
    expect(resolveChainParam('celo', EVM)).toBe('celo');
    expect(resolveChainParam(null, EVM)).toBeNull();
  });
});
