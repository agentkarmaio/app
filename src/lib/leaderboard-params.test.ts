/// <reference types="bun-types" />
/**
 * Unit tests for parseChain — leaderboard ?chain= query-param validation.
 * Run: bun test src/lib/leaderboard-params.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { parseChain } from './leaderboard-params';

describe('parseChain', () => {
  test('valid chains pass through', () => {
    expect(parseChain('solana')).toBe('solana');
    expect(parseChain('celo')).toBe('celo');
    expect(parseChain('arc')).toBe('arc');
  });

  test('null / empty / unknown → undefined (no filter)', () => {
    expect(parseChain(null)).toBeUndefined();
    expect(parseChain('')).toBeUndefined();
    expect(parseChain('bitcoin')).toBeUndefined();
  });

  test('is case-sensitive against canonical CHAINS values', () => {
    expect(parseChain('Solana')).toBeUndefined();
    expect(parseChain('SOLANA')).toBeUndefined();
  });

  test('tracks CHAINS tuple — stellar accepted once U1 adds it', async () => {
    const { CHAINS } = await import('@/db/schema');
    if ((CHAINS as readonly string[]).includes('stellar')) {
      expect(parseChain('stellar')).toBe('stellar');
    } else {
      expect(parseChain('stellar')).toBeUndefined();
    }
  });
});
