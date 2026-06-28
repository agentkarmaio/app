/// <reference types="bun-types" />
/**
 * Tests for the facilitator-set merge that powers the self-seeder: the indexer
 * unions the curated/env set with verified discovered payees. Covers the union,
 * the preserved empty-set no-op, the lowercasing, malformed-entry rejection, and
 * the DB-error fall-back to the sync set.
 *
 * The discovered-payee loader is INJECTED, so no live Supabase is touched.
 *
 * Run: bun test src/config/celo-x402.test.ts
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  celoX402FacilitatorSet,
  celoX402FacilitatorSetWithDiscovered,
} from './celo-x402';

const ENV_ADDR = '0xAAaAAaaAAaaaAAAaaAaaAaAAAaAaAaAaAAaAaAaA';
const DISC_ADDR = '0xBbBBBBBBBBBBBBBBbbbbBBBBBBBBBBBBBBBBBBBB';

const savedEnv = process.env.CELO_X402_FACILITATORS;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.CELO_X402_FACILITATORS;
  else process.env.CELO_X402_FACILITATORS = savedEnv;
});

describe('celoX402FacilitatorSet (sync, curated + env)', () => {
  test('empty when no curated entries and no env', () => {
    delete process.env.CELO_X402_FACILITATORS;
    expect(celoX402FacilitatorSet().size).toBe(0);
  });

  test('includes a valid env address, lowercased', () => {
    process.env.CELO_X402_FACILITATORS = ENV_ADDR;
    const set = celoX402FacilitatorSet();
    expect(set.has(ENV_ADDR.toLowerCase())).toBe(true);
  });

  test('drops malformed env entries', () => {
    process.env.CELO_X402_FACILITATORS = `not-an-addr, 0x123, ${ENV_ADDR}`;
    const set = celoX402FacilitatorSet();
    expect(set.size).toBe(1);
    expect(set.has(ENV_ADDR.toLowerCase())).toBe(true);
  });
});

describe('celoX402FacilitatorSetWithDiscovered (async merge)', () => {
  test('unions env set with discovered payees (both lowercased)', async () => {
    process.env.CELO_X402_FACILITATORS = ENV_ADDR;
    const set = await celoX402FacilitatorSetWithDiscovered(
      async () => new Set([DISC_ADDR.toLowerCase()]),
    );
    expect(set.has(ENV_ADDR.toLowerCase())).toBe(true);
    expect(set.has(DISC_ADDR.toLowerCase())).toBe(true);
    expect(set.size).toBe(2);
  });

  test('discovered-only: empty curated/env + discovered payees → non-empty', async () => {
    delete process.env.CELO_X402_FACILITATORS;
    const set = await celoX402FacilitatorSetWithDiscovered(
      async () => new Set([DISC_ADDR.toLowerCase()]),
    );
    expect(set.size).toBe(1);
    expect(set.has(DISC_ADDR.toLowerCase())).toBe(true);
  });

  test('empty-set no-op preserved: all sources empty → empty set', async () => {
    delete process.env.CELO_X402_FACILITATORS;
    const set = await celoX402FacilitatorSetWithDiscovered(async () => new Set());
    expect(set.size).toBe(0);
  });

  test('drops malformed discovered entries (defense-in-depth)', async () => {
    delete process.env.CELO_X402_FACILITATORS;
    const set = await celoX402FacilitatorSetWithDiscovered(
      async () => new Set(['garbage', '0x123', DISC_ADDR.toLowerCase()]),
    );
    expect(set.size).toBe(1);
    expect(set.has(DISC_ADDR.toLowerCase())).toBe(true);
  });

  test('DB read failure falls back to the sync set (does not throw)', async () => {
    process.env.CELO_X402_FACILITATORS = ENV_ADDR;
    const set = await celoX402FacilitatorSetWithDiscovered(async () => {
      throw new Error('supabase down');
    });
    // Curated/env set still indexes; the union just degrades to it.
    expect(set.has(ENV_ADDR.toLowerCase())).toBe(true);
    expect(set.size).toBe(1);
  });

  test('de-dupes when an env address is also a discovered payee', async () => {
    process.env.CELO_X402_FACILITATORS = ENV_ADDR;
    const set = await celoX402FacilitatorSetWithDiscovered(
      async () => new Set([ENV_ADDR.toLowerCase()]),
    );
    expect(set.size).toBe(1);
  });
});
