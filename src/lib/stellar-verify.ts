/**
 * Stellar claim signature-verify core (SECURITY-CRITICAL, server-safe / pure).
 *
 * A Stellar (G…) wallet proves ownership by signing the canonical claim
 * challenge with its Ed25519 key via Freighter `signMessage`, which implements
 * SEP-53. Crucially, Freighter does NOT sign the raw message bytes — it signs
 * the SEP-53 payload:
 *
 *     signature = Ed25519_sign( sha256( utf8("Stellar Signed Message:\n") || utf8(message) ) )
 *
 * (SEP-0053 §"Payload", confirmed against the spec's Test Case 1 vector). The
 * server MUST verify the detached signature over that SAME hash, NOT over the
 * unprefixed message — verifying the raw bytes rejects every real Freighter
 * signature. We decode the public key from its StrKey G-address and check the
 * detached signature with `nacl.sign.detached.verify` over the SEP-53 digest.
 * No React, no next/*, no network — importable from the route and unit-tested
 * in isolation.
 *
 * v1 supports only G… Ed25519 accounts. C… Soroban contract addresses
 * (smart wallets) authenticate via `__check_auth`, not a raw Ed25519 signature,
 * and are rejected.
 */
import { StrKey } from '@stellar/stellar-sdk';
// @noble/hashes@2.x exposes sha256 under the `sha2` entrypoint (matches the
// import in erc8004-stellar-publish.ts). Verified against the installed v2.x.
import { sha256 } from '@noble/hashes/sha2.js';
import nacl from 'tweetnacl';

/** SEP-53 domain-separation prefix, UTF-8 (24 bytes). Spec literal — do not change. */
const SEP53_PREFIX = 'Stellar Signed Message:\n';

/**
 * Canonical claim challenge. MUST stay byte-identical to the Solana path
 * (src/components/karma/claim-banner.tsx:65 + src/app/api/agent/claim/route.ts:96)
 * so one signing contract spans every chain.
 */
export function buildStellarClaimChallenge(address: string, timestampMs: number): string {
  return `AgentKarma: Claim wallet ${address} at ${timestampMs}`;
}

/** True only for G… Ed25519 public keys. C… smart-wallet contracts are rejected in v1. */
export function isStellarAddress(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address);
}

/** True for C… Soroban contract addresses (smart wallets) — excluded in v1. */
export function isStellarContractAddress(address: string): boolean {
  return StrKey.isValidContract(address);
}

/** Decode an even-length hex string (optional 0x prefix) to bytes. Throws on malformed input. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('hex string has odd length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`invalid hex at byte ${i}`);
    out[i] = byte;
  }
  return out;
}

/**
 * Compute the SEP-53 signing payload digest for `message`:
 *
 *     sha256( utf8("Stellar Signed Message:\n") || utf8(message) )
 *
 * This is the exact 32-byte payload Freighter `signMessage` signs with raw
 * Ed25519 (SEP-0053 §"Payload"; reproduces the spec's Test Case 1 vector). The
 * server verifies the detached signature over THIS hash, never the raw message.
 */
export function sep53MessageHash(message: string): Uint8Array {
  const prefixBytes = new TextEncoder().encode(SEP53_PREFIX);
  const messageBytes = new TextEncoder().encode(message);
  const payload = new Uint8Array(prefixBytes.length + messageBytes.length);
  payload.set(prefixBytes, 0);
  payload.set(messageBytes, prefixBytes.length);
  return sha256(payload);
}

/**
 * Verify a Freighter (SEP-53) Ed25519 signature over the claim challenge.
 *
 * Freighter signs the SEP-53 payload (sha256 of the prefixed message), so the
 * server verifies the detached signature over `sep53MessageHash(message)`, NOT
 * the raw message bytes — verifying raw bytes would reject every real signature.
 *
 * Returns false (NEVER throws) so the route maps every failure cleanly to a
 * 401 without leaking which check failed. Rejects:
 *   - C… contracts / any non-G… StrKey (smart wallets, malformed addresses)
 *   - malformed / wrong-length (≠64-byte) signatures
 *   - tampered message or signature, or a signature from a different key
 *   - a raw-bytes (non-SEP-53) signature over the message
 */
export function verifyStellarClaimSignature(
  address: string,
  message: string,
  signatureHex: string,
): boolean {
  try {
    if (!isStellarAddress(address)) return false; // also rejects C… contracts
    const publicKeyBytes = StrKey.decodeEd25519PublicKey(address); // Uint8Array[32]
    const digest = sep53MessageHash(message); // SEP-53 payload (Freighter signs this)
    const signatureBytes = hexToBytes(signatureHex); // Uint8Array[64]
    if (signatureBytes.length !== 64) return false;
    return nacl.sign.detached.verify(digest, signatureBytes, publicKeyBytes);
  } catch {
    return false;
  }
}
