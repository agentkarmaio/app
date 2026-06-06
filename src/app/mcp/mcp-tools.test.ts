/// <reference types="bun-types" />
/**
 * Unit tests for the MCP wallet schema + Stellar tool registration.
 *
 * Run: bun test src/app/mcp/mcp-tools.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { walletSchema } from './route';

const SOLANA = '3rGu9hPHdgwR8KeZTpPkN4Z5VRBeR3LBs9CAnqJ7yDjZ';      // 44 chars
const STELLAR = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'; // 56 chars

describe('walletSchema', () => {
  test('accepts a Solana base58 address (44 chars)', () => {
    expect(walletSchema.safeParse(SOLANA).success).toBe(true);
  });

  test('accepts a Stellar StrKey address (56 chars)', () => {
    expect(walletSchema.safeParse(STELLAR).success).toBe(true);
  });

  test('rejects too-short strings (<32)', () => {
    expect(walletSchema.safeParse('abc').success).toBe(false);
  });

  test('rejects too-long strings (>56)', () => {
    expect(walletSchema.safeParse('G'.repeat(57)).success).toBe(false);
  });
});
