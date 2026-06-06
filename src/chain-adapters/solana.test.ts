/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { makeSolanaAdapter } from './solana';

const a = makeSolanaAdapter();
const GOOD = 'So11111111111111111111111111111111111111112'; // wrapped SOL mint, valid base58 pubkey

describe('makeSolanaAdapter', () => {
  test('chain is solana', () => { expect(a.chain).toBe('solana'); });
  test('validateAddress accepts a base58 pubkey, rejects junk', () => {
    expect(a.validateAddress(GOOD)).toBe(true);
    expect(a.validateAddress('0xdeadbeef')).toBe(false);
    expect(a.validateAddress('')).toBe(false);
  });
  test('normalizeAddress round-trips a valid pubkey unchanged', () => {
    expect(a.normalizeAddress(GOOD)).toBe(GOOD);
  });
  test('explorer URLs target solscan', () => {
    expect(a.explorerTxUrl('sig')).toBe('https://solscan.io/tx/sig');
    expect(a.explorerAddressUrl(GOOD)).toBe(`https://solscan.io/account/${GOOD}`);
  });
});
