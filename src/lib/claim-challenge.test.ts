/// <reference types="bun-types" />
/**
 * claim-challenge — metadata-binding primitive (SECURITY-CRITICAL).
 *
 * The hash MUST be deterministic and sensitive to every bound field, and
 * messageBindsMetadata MUST reject a message that binds different metadata or
 * carries no binding at all. Client and server both call these, so any drift
 * here silently breaks the replay protection.
 */
import { describe, expect, test } from 'bun:test';
import {
  canonicalAgentMetadata,
  metadataHash,
  bindMetadata,
  messageBindsMetadata,
  CHALLENGE_HASH_SEP,
} from './claim-challenge';

describe('canonicalAgentMetadata', () => {
  test('fixed key order; missing fields → null; stable shape', () => {
    expect(canonicalAgentMetadata({ displayName: 'a' })).toBe(
      '{"displayName":"a","description":null,"website":null,"category":null,"imageUrl":null,"tempoAddress":null,"succession":null}',
    );
  });

  test('undefined and null normalize identically', () => {
    expect(canonicalAgentMetadata({ displayName: 'a', description: undefined })).toBe(
      canonicalAgentMetadata({ displayName: 'a', description: null }),
    );
  });
});

describe('metadataHash', () => {
  test('deterministic for the same input', async () => {
    const a = await metadataHash({ displayName: 'x', website: 'https://x.io' });
    const b = await metadataHash({ displayName: 'x', website: 'https://x.io' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  test('sensitive to every field (no two distinct inputs collide here)', async () => {
    const base = { displayName: 'x', description: 'd', website: 'w', category: 'ai', imageUrl: 'i', tempoAddress: 't' };
    const variants = [
      { ...base, displayName: 'X' },
      { ...base, description: 'D' },
      { ...base, website: 'W' },
      { ...base, category: 'defi' },
      { ...base, imageUrl: 'I' },
      { ...base, tempoAddress: 'T' },
    ];
    const hashes = await Promise.all([base, ...variants].map(metadataHash));
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  test('succession plan is bound, heir-order-independent', async () => {
    const plan = (heirs: Array<{ address: string; chain: string }>) => ({
      displayName: 'x',
      succession: { intervalSeconds: 100, heirs },
    });
    const a = await metadataHash(plan([{ address: 'A', chain: 'solana' }, { address: 'B', chain: 'solana' }]));
    const b = await metadataHash(plan([{ address: 'B', chain: 'solana' }, { address: 'A', chain: 'solana' }]));
    expect(a).toBe(b); // heir array order must not change the hash
    const attacker = await metadataHash(plan([{ address: 'ATTACKER', chain: 'solana' }]));
    expect(attacker).not.toBe(a); // a swapped heir → different hash
    expect(await metadataHash({ displayName: 'x' })).not.toBe(a); // declaring a plan changes the hash
  });
});

describe('messageBindsMetadata', () => {
  const meta = { displayName: 'Agent', description: 'hi', category: 'ai' };

  test('true when the message binds exactly this metadata', async () => {
    const msg = bindMetadata('AgentKarma: Claim wallet G… at 123', await metadataHash(meta));
    expect(await messageBindsMetadata(msg, meta)).toBe(true);
  });

  test('false when the body metadata differs (replay with swapped fields)', async () => {
    const msg = bindMetadata('AgentKarma: Claim wallet G… at 123', await metadataHash(meta));
    expect(await messageBindsMetadata(msg, { ...meta, displayName: 'PWNED' })).toBe(false);
  });

  test('false when the message carries no binding at all', async () => {
    expect(await messageBindsMetadata('AgentKarma: Claim wallet G… at 123', meta)).toBe(false);
  });

  test('separator is the documented constant', () => {
    expect(bindMetadata('base', 'abc')).toBe(`base${CHALLENGE_HASH_SEP}abc`);
  });
});
