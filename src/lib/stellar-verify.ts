/**
 * Stellar claim signature-verify core (SECURITY-CRITICAL, server-safe / pure).
 *
 * A Stellar (G…) wallet proves ownership by signing the canonical claim
 * challenge with its Ed25519 key (Freighter `signMessage`). The server replays
 * the exact challenge and verifies the detached signature with the SAME
 * primitive the Solana claim route uses (`nacl.sign.detached.verify`,
 * src/app/api/agent/claim/route.ts:114), decoding the public key from its
 * StrKey G-address. No React, no next/*, no network — importable from the route
 * and unit-tested in isolation.
 *
 * v1 supports only G… Ed25519 accounts. C… Soroban contract addresses
 * (smart wallets) authenticate via `__check_auth`, not a raw Ed25519 signature,
 * and are rejected.
 */
import { StrKey } from '@stellar/stellar-sdk';
import nacl from 'tweetnacl';

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
 * Verify a Freighter Ed25519 signature over the claim challenge.
 *
 * Returns false (NEVER throws) so the route maps every failure cleanly to a
 * 401 without leaking which check failed. Rejects:
 *   - C… contracts / any non-G… StrKey (smart wallets, malformed addresses)
 *   - malformed / wrong-length (≠64-byte) signatures
 *   - tampered message or signature, or a signature from a different key
 */
export function verifyStellarClaimSignature(
  address: string,
  message: string,
  signatureHex: string,
): boolean {
  try {
    if (!isStellarAddress(address)) return false; // also rejects C… contracts
    const publicKeyBytes = StrKey.decodeEd25519PublicKey(address); // Uint8Array[32]
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = hexToBytes(signatureHex); // Uint8Array[64]
    if (signatureBytes.length !== 64) return false;
    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
  } catch {
    return false;
  }
}
