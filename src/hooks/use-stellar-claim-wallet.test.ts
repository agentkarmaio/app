/// <reference types="bun-types" />
/**
 * Unit tests for the pure helpers behind useStellarClaimWallet. The hook's
 * wallet-modal + Freighter interaction is browser-only (manual), but the
 * challenge formatting and the Freighter signature -> hex normalization are
 * pure and security-relevant, so they are tested here.
 *
 * The challenge MUST be byte-identical to the Solana path
 * (src/components/karma/claim-banner.tsx:65 + src/app/api/agent/claim/route.ts:96)
 * so one signing contract spans every chain.
 */
import { describe, expect, test } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';
import {
  buildStellarClaimChallenge,
  normalizeFreighterSignatureToHex,
} from './use-stellar-claim-wallet';

// Real StrKey-encoded G… address from a fixed seed (no truncated placeholders).
const G = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();

describe('buildStellarClaimChallenge', () => {
  test('matches the Solana challenge format byte-for-byte', () => {
    expect(buildStellarClaimChallenge(G, 1700000000000)).toBe(
      `AgentKarma: Claim wallet ${G} at 1700000000000`,
    );
  });

  test('stringifies the timestamp identically to Date.now().toString()', () => {
    // Solana builds the message with Date.now().toString(); a numeric ts must
    // serialize the same way (no scientific notation, no separators).
    const ts = 1_700_000_000_123;
    expect(buildStellarClaimChallenge(G, ts)).toBe(
      `AgentKarma: Claim wallet ${G} at ${ts}`,
    );
  });
});

describe('normalizeFreighterSignatureToHex', () => {
  // A 64-byte Ed25519 signature is what Freighter returns for signMessage; we
  // build one deterministically and assert every documented carrier shape maps
  // to the same canonical lowercase hex.
  const kp = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
  const message = buildStellarClaimChallenge(kp.publicKey(), 1700000000000);
  const sigBytes = kp.sign(Buffer.from(message, 'utf-8')); // Buffer[64]
  const expectedHex = Buffer.from(sigBytes).toString('hex');

  test('Buffer (Freighter V3 carrier) -> lowercase hex', () => {
    expect(normalizeFreighterSignatureToHex(Buffer.from(sigBytes))).toBe(expectedHex);
  });

  test('Uint8Array carrier -> lowercase hex', () => {
    expect(normalizeFreighterSignatureToHex(new Uint8Array(sigBytes))).toBe(expectedHex);
  });

  test('base64 string (Freighter V4 carrier) -> lowercase hex', () => {
    const b64 = Buffer.from(sigBytes).toString('base64');
    expect(normalizeFreighterSignatureToHex(b64)).toBe(expectedHex);
  });

  test('hex string passes through unchanged (already canonical)', () => {
    expect(normalizeFreighterSignatureToHex(expectedHex)).toBe(expectedHex);
  });

  test('uppercase hex string is normalized to lowercase', () => {
    expect(normalizeFreighterSignatureToHex(expectedHex.toUpperCase())).toBe(expectedHex);
  });

  test('throws on null (Freighter signals failure with signedMessage=null)', () => {
    expect(() => normalizeFreighterSignatureToHex(null)).toThrow(
      'Freighter returned no signature',
    );
  });

  test('throws on empty string', () => {
    expect(() => normalizeFreighterSignatureToHex('')).toThrow(
      'Freighter returned no signature',
    );
  });
});
