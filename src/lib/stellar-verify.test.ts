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
import {
  buildStellarClaimChallenge,
  isStellarAddress,
  isStellarContractAddress,
  hexToBytes,
  verifyStellarClaimSignature,
} from './stellar-verify';

// G… Ed25519 public key (real, deterministic seed) and a C… contract address.
const kp = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
const G = kp.publicKey();
const C = StrKey.encodeContract(Buffer.alloc(32, 9));

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

describe('verifyStellarClaimSignature (the security gate)', () => {
  const ts = 1700000000000;
  const message = buildStellarClaimChallenge(G, ts);
  const sigHex = Buffer.from(kp.sign(Buffer.from(message, 'utf-8'))).toString('hex');

  test('valid signature over the exact challenge → true', () => {
    expect(verifyStellarClaimSignature(G, message, sigHex)).toBe(true);
  });

  test('signature from a DIFFERENT key → false (impersonation blocked)', () => {
    const other = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8));
    const otherSig = Buffer.from(other.sign(Buffer.from(message))).toString('hex');
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
