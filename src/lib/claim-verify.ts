/**
 * Canonical claim-signature verification (SECURITY-CRITICAL, isomorphic).
 *
 * Single source of truth for "did the keyholder sign the claim challenge?",
 * shared by every path that needs the answer:
 *   - the claim routes        (server, /api/agent/claim[/evm|/stellar])
 *   - the prove-ownership route (server, /api/agent/prove)
 *   - the on-page proof receipt (client, lib/claim-proof-verify.ts via dynamic import)
 *
 * The challenge is byte-identical across chains:
 *   AgentKarma: Claim wallet {address} at {unixMillis}
 * Each chain verifies it with its native primitive:
 *   - solana  : Ed25519 over the raw UTF-8 challenge (tweetnacl)
 *   - celo/arc: EIP-191 personal_sign recovery (viem)
 *   - stellar : SEP-53 Ed25519 (lib/stellar-verify)
 *
 * Pure + isomorphic: no React, no next/*, no network — safe to import from a
 * route handler OR (dynamically) from a client component. Every verifier returns
 * a boolean and never throws on malformed input — callers map false → 401.
 */
import nacl from 'tweetnacl';
import { PublicKey } from '@solana/web3.js';
import { verifyMessage } from 'viem';
import type { Chain } from '@/db/schema';
import { verifyStellarClaimSignature } from '@/lib/stellar-verify';

/** Canonical claim challenge. MUST stay byte-identical across every chain + the banners. */
export function buildClaimChallenge(address: string, timestampMs: number | string): string {
  return `AgentKarma: Claim wallet ${address} at ${timestampMs}`;
}

/** Minimal base58 decode (Solana signatures are base58). Throws on invalid chars. */
function bs58Decode(str: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const BASE = BigInt(58);
  let num = BigInt(0);
  for (const char of str) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base58 character: ${char}`);
    num = num * BASE + BigInt(index);
  }
  const hex = num.toString(16).padStart(2, '0');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  let leadingZeros = 0;
  for (const char of str) {
    if (char === '1') leadingZeros++;
    else break;
  }
  const result = new Uint8Array(leadingZeros + bytes.length);
  result.set(bytes, leadingZeros);
  return result;
}

/** Ed25519 over the raw challenge bytes. `signature` is base58. */
export function verifySolanaClaimSignature(address: string, message: string, signature: string): boolean {
  try {
    const pub = new PublicKey(address).toBytes();
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58Decode(signature);
    return nacl.sign.detached.verify(messageBytes, signatureBytes, pub);
  } catch {
    return false;
  }
}

/** EIP-191 personal_sign recovery, checksum-insensitive. `signature` is 0x-hex. */
export async function verifyEvmClaimSignature(address: string, message: string, signature: string): Promise<boolean> {
  try {
    return await verifyMessage({
      address: address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}

export { verifyStellarClaimSignature };

/** Dispatch to the chain's native verifier. Never throws — false on any failure. */
export async function verifyClaimSignature(
  chain: Chain,
  address: string,
  message: string,
  signature: string,
): Promise<boolean> {
  switch (chain) {
    case 'solana':
      return verifySolanaClaimSignature(address, message, signature);
    case 'celo':
    case 'arc':
      return verifyEvmClaimSignature(address, message, signature);
    case 'stellar':
      return verifyStellarClaimSignature(address, message, signature);
    default:
      return false;
  }
}
