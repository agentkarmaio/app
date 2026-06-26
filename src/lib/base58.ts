/**
 * base58 encoding (zero-dep, BigInt). Single source of truth for the Solana
 * signature → wire-string encode shared by every signing surface:
 *   - claim form (components/karma/claim-banner.tsx)
 *   - prove-ownership card (components/wallet/prove-ownership.tsx)
 *   - edit-profile card (components/wallet/edit-profile.tsx)
 *
 * Matches the codebase's deliberate hand-rolled-zero-dep posture (claim-verify.ts
 * hand-rolls the base58 *decoder*; this is the encoder). Only Solana needs it —
 * EVM signatures are 0x-hex from the provider, Stellar are hex from the hook.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Encode raw bytes (e.g. a 64-byte Ed25519 signature) to a base58 string. */
export function uint8ArrayToBase58(bytes: Uint8Array): string {
  let num = BigInt(0);
  for (const byte of bytes) {
    num = num * BigInt(256) + BigInt(byte);
  }
  let str = '';
  while (num > BigInt(0)) {
    str = ALPHABET[Number(num % BigInt(58))] + str;
    num = num / BigInt(58);
  }
  // Preserve leading zero bytes as leading '1's (base58 convention).
  for (const byte of bytes) {
    if (byte === 0) str = '1' + str;
    else break;
  }
  return str || '1';
}
