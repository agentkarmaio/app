/// <reference types="bun-types" />
/**
 * Unit tests for the Stellar claim signature-verify core (SECURITY-CRITICAL).
 *
 * Fixtures are generated inline from StrKey/Keypair (Correction C5) — never a
 * truncated/placeholder StrKey. A claim is authenticated entirely by the
 * Ed25519 signature over the canonical challenge, so these adversarial cases
 * (tampered message, tampered signature, wrong key, C… contract, malformed hex)
 * are the gate between "anyone can claim any wallet" and "only the keyholder can".
 */
import { describe, expect, test } from 'bun:test';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  buildStellarClaimChallenge,
  isStellarAddress,
  isStellarContractAddress,
  hexToBytes,
  sep53MessageHash,
  verifyStellarClaimSignature,
} from './stellar-verify';

// G… Ed25519 public key (real, deterministic seed) and a C… contract address.
const kp = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
const G = kp.publicKey();
const C = StrKey.encodeContract(Buffer.alloc(32, 9));

/**
 * Sign the way real Freighter (`@stellar/freighter-api` signMessage) does:
 * raw Ed25519 over the SEP-53 payload sha256("Stellar Signed Message:\n" || msg),
 * NOT over the raw message bytes. This is the construction the live wallet
 * produces — the fixtures MUST match it or the server verify is testing a
 * primitive no real client uses.
 */
function freighterSignHex(signer: Keypair, message: string): string {
  const prefix = new TextEncoder().encode('Stellar Signed Message:\n');
  const msg = new TextEncoder().encode(message);
  const payload = new Uint8Array(prefix.length + msg.length);
  payload.set(prefix, 0);
  payload.set(msg, prefix.length);
  const digest = sha256(payload);
  return Buffer.from(signer.sign(Buffer.from(digest))).toString('hex');
}

describe('buildStellarClaimChallenge', () => {
  test('matches the Solana challenge format byte-for-byte', () => {
    expect(buildStellarClaimChallenge(G, 1700000000000)).toBe(
      `AgentKarma: Claim wallet ${G} at 1700000000000`,
    );
  });
});

describe('address guards', () => {
  test('isStellarAddress accepts G… Ed25519 public keys', () => {
    expect(isStellarAddress(G)).toBe(true);
  });
  test('isStellarAddress rejects C… contract addresses', () => {
    expect(isStellarAddress(C)).toBe(false);
  });
  test('isStellarAddress rejects Solana base58', () => {
    expect(isStellarAddress('11111111111111111111111111111111')).toBe(false);
  });
  test('isStellarAddress rejects empty string', () => {
    expect(isStellarAddress('')).toBe(false);
  });
  test('isStellarContractAddress only matches C…', () => {
    expect(isStellarContractAddress(C)).toBe(true);
    expect(isStellarContractAddress(G)).toBe(false);
  });
});

describe('hexToBytes', () => {
  test('round-trips a short hex string', () => {
    expect(Array.from(hexToBytes('00ff10'))).toEqual([0, 255, 16]);
  });
  test('tolerates a 0x prefix', () => {
    expect(Array.from(hexToBytes('0x00ff10'))).toEqual([0, 255, 16]);
  });
  test('odd-length hex throws', () => {
    expect(() => hexToBytes('abc')).toThrow();
  });
  test('non-hex characters throw', () => {
    expect(() => hexToBytes('zzzz')).toThrow();
  });
});

describe('sep53MessageHash (SEP-53 signing payload)', () => {
  // Known-answer test against SEP-53 §"Test cases", Test Case 1 (ASCII).
  // Proves sep53MessageHash == sha256("Stellar Signed Message:\n" || msg) and
  // that raw Ed25519 over that hash reproduces the spec's signature exactly.
  const SPEC_SEED = 'SAKICEVQLYWGSOJS4WW7HZJWAHZVEEBS527LHK5V4MLJALYKICQCJXMW';
  const SPEC_ADDR = 'GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L';
  const SPEC_SIG_HEX =
    '7cee5d6d885752104c85eea421dfdcb95abf01f1271d11c4bec3fcbd7874dccd' +
    '6e2e98b97b8eb23b643cac4073bb77de5d07b0710139180ae9f3cbba78f2ba04';

  test('matches the SEP-53 test vector (hash → signature)', () => {
    const specKp = Keypair.fromSecret(SPEC_SEED);
    expect(specKp.publicKey()).toBe(SPEC_ADDR);
    const digest = sep53MessageHash('Hello, World!');
    const sig = Buffer.from(specKp.sign(Buffer.from(digest))).toString('hex');
    expect(sig).toBe(SPEC_SIG_HEX);
  });

  test('differs from a raw-message sha256 (prefix is included)', () => {
    const withPrefix = sep53MessageHash('Hello, World!');
    const noPrefix = sha256(new TextEncoder().encode('Hello, World!'));
    expect(Buffer.from(withPrefix).equals(Buffer.from(noPrefix))).toBe(false);
  });
});

describe('verifyStellarClaimSignature (the security gate)', () => {
  const ts = 1700000000000;
  const message = buildStellarClaimChallenge(G, ts);
  // Sign the way REAL Freighter does: SEP-53 (sha256 of the prefixed message),
  // not raw bytes. This is the only signature a live wallet ever produces.
  const sigHex = freighterSignHex(kp, message);

  test('valid SEP-53 (real Freighter) signature over the challenge → true', () => {
    expect(verifyStellarClaimSignature(G, message, sigHex)).toBe(true);
  });

  test('raw-bytes signature (NOT SEP-53) → false — rejects the wrong primitive', () => {
    const rawSig = Buffer.from(kp.sign(Buffer.from(message, 'utf-8'))).toString('hex');
    expect(verifyStellarClaimSignature(G, message, rawSig)).toBe(false);
  });

  test('signature from a DIFFERENT key → false (impersonation blocked)', () => {
    const other = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8));
    const otherSig = freighterSignHex(other, message);
    expect(verifyStellarClaimSignature(G, message, otherSig)).toBe(false);
  });

  test('tampered message → false (signed payload binding enforced)', () => {
    expect(verifyStellarClaimSignature(G, message + 'x', sigHex)).toBe(false);
  });

  test('tampered signature byte → false', () => {
    const bad = sigHex.slice(0, -2) + (sigHex.endsWith('00') ? 'ff' : '00');
    expect(verifyStellarClaimSignature(G, message, bad)).toBe(false);
  });

  test('malformed (non-hex) signature → false, never throws', () => {
    expect(verifyStellarClaimSignature(G, message, 'zzzz')).toBe(false);
  });

  test('wrong-length signature → false', () => {
    expect(verifyStellarClaimSignature(G, message, 'deadbeef')).toBe(false);
  });

  test('C… contract address → false (smart wallets excluded in v1)', () => {
    expect(verifyStellarClaimSignature(C, message, sigHex)).toBe(false);
  });

  test('wrong-length / malformed StrKey address → false, never throws', () => {
    expect(verifyStellarClaimSignature('GABC', message, sigHex)).toBe(false);
    expect(verifyStellarClaimSignature(G.slice(0, -1), message, sigHex)).toBe(false);
  });
});
