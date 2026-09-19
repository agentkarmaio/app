/// <reference types="bun-types" />
/**
 * Regression: 2026-09-19. Attestation reads preferred a metered credential that
 * was rejecting every call, and the 8004 SDK swallows its own errors — it
 * returns `{ averageScore: 0 }` rather than throwing. Two consequences, both
 * silent:
 *
 *   1. `calculateScore` treats `attestation === 0` as ABSENT and redistributes
 *      Tier-1 weight, so every wallet that really had 8004 feedback was scored
 *      as though it had none, for as long as the endpoint stayed unavailable.
 *   2. Each read burned the full 5 s deadline. One keep-fresh run spent ~226 s
 *      of its 600 s lease this way and was killed mid-scan.
 *
 * So availability must be established OUT OF BAND (a raw probe the SDK cannot
 * swallow), cached, and reported to anyone who persists a score.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  ENDPOINT_COOLDOWN_MS,
  readAttestationsDetailed,
  resetAttestationEndpoints,
} from './attestation';
import { solanaReadRpcUrls, DEFAULT_SOLANA_RPC } from '@/lib/solana-rpc';

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
  resetAttestationEndpoints();
});

describe('solanaReadRpcUrls orders free endpoints ahead of metered ones', () => {
  test('SOLANA_RPC_URL first, then Helius, then the public endpoint', () => {
    const urls = solanaReadRpcUrls({
      SOLANA_RPC_URL: 'https://free.example/rpc',
      HELIUS_RPC_URL: 'https://helius.example/?api-key=k',
    });
    expect(urls).toEqual([
      'https://free.example/rpc',
      'https://helius.example/?api-key=k',
      DEFAULT_SOLANA_RPC,
    ]);
  });

  // An unset CI secret arrives as the empty string; `??` would accept it.
  test('an empty SOLANA_RPC_URL is absent, not a configured endpoint', () => {
    expect(solanaReadRpcUrls({ SOLANA_RPC_URL: '   ', HELIUS_RPC_URL: 'https://h/?api-key=k' }))
      .toEqual(['https://h/?api-key=k', DEFAULT_SOLANA_RPC]);
  });

  test('nothing configured still yields a usable endpoint', () => {
    expect(solanaReadRpcUrls({})).toEqual([DEFAULT_SOLANA_RPC]);
  });

  test('the same URL configured twice is tried once', () => {
    expect(solanaReadRpcUrls({ SOLANA_RPC_URL: DEFAULT_SOLANA_RPC })).toEqual([DEFAULT_SOLANA_RPC]);
  });
});

describe('readAttestationsDetailed reports unavailability instead of faking zeros', () => {
  test('every endpoint refusing → unavailable, no SDK calls, no scores', async () => {
    process.env.SOLANA_RPC_URL = 'https://free.example/rpc';
    process.env.HELIUS_RPC_URL = 'https://helius.example/?api-key=k';
    resetAttestationEndpoints();

    const probed: string[] = [];
    const out = await readAttestationsDetailed(['w1', 'w2', 'w3'], {
      probe: async (url) => { probed.push(url); return false; },
      now: () => 1_000,
    });

    // The whole point: this is NOT "three wallets with no feedback".
    expect(out.unavailable).toBe(true);
    expect(out.scores.size).toBe(0);
    // One probe per endpoint for the entire batch — never one per wallet.
    expect(probed).toEqual([
      'https://free.example/rpc',
      'https://helius.example/?api-key=k',
      DEFAULT_SOLANA_RPC,
    ]);
  });

  test('a cold endpoint is not re-probed until the cooldown expires', async () => {
    process.env.SOLANA_RPC_URL = 'https://free.example/rpc';
    resetAttestationEndpoints();

    let probes = 0;
    const probe = async () => { probes++; return false; };

    await readAttestationsDetailed(['w1'], { probe, now: () => 1_000 });
    const afterFirst = probes;
    await readAttestationsDetailed(['w2'], { probe, now: () => 1_000 + ENDPOINT_COOLDOWN_MS - 1 });
    expect(probes).toBe(afterFirst);

    await readAttestationsDetailed(['w3'], { probe, now: () => 1_000 + ENDPOINT_COOLDOWN_MS + 1 });
    expect(probes).toBeGreaterThan(afterFirst);
  });

  test('an empty wallet list is available by definition and probes nothing', async () => {
    let probes = 0;
    const out = await readAttestationsDetailed([], { probe: async () => { probes++; return true; } });
    expect(out.unavailable).toBe(false);
    expect(probes).toBe(0);
  });

  // The free endpoint answering means the metered one is never consulted, which
  // is the whole reason the list is ordered.
  test('a healthy free endpoint stops the walk before any metered credential', async () => {
    process.env.SOLANA_RPC_URL = 'https://free.example/rpc';
    process.env.HELIUS_RPC_URL = 'https://helius.example/?api-key=k';
    resetAttestationEndpoints();

    const probed: string[] = [];
    const out = await readAttestationsDetailed(['w1'], {
      probe: async (url) => { probed.push(url); return true; },
      now: () => 1_000,
    });

    expect(probed).toEqual(['https://free.example/rpc']);
    expect(out.unavailable).toBe(false);
  });
});
