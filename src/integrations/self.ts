/**
 * Self Protocol integration — backend verifier for proof-of-human anchoring.
 *
 * Flow:
 *  1. User scans passport in Self mobile app, with AK's QR scope shown
 *  2. App generates ZK proof, posts to /api/v2/self/verify
 *  3. This module verifies the proof + extracts the nullifier
 *  4. Route handler stores nullifier on the wallet row (Tier 3 Autonomy
 *     Confidence anchor — see RFC v0.3 §5.5)
 *
 * Self IdentityVerificationHub on Celo mainnet:
 *   0xe57F4773bd9c9d8b6Cd70431117d353298B9f5BF
 *
 * Docs: https://docs.self.xyz
 */

import {
  SelfBackendVerifier,
  DefaultConfigStore,
  AllIds,
} from '@selfxyz/core';

export const SELF_SCOPE = 'agentkarma' as const; // max 30 chars, must match frontend
export const SELF_ENDPOINT_PATH = '/api/v2/self/verify';

let _verifier: SelfBackendVerifier | null = null;

export function getSelfVerifier(): SelfBackendVerifier {
  if (_verifier) return _verifier;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io';
  const endpoint = `${appUrl}${SELF_ENDPOINT_PATH}`;

  // Mainnet = real passports. Set SELF_MOCK=1 for Celo Sepolia testing.
  const mockPassport = process.env.SELF_MOCK === '1';

  _verifier = new SelfBackendVerifier(
    SELF_SCOPE,
    endpoint,
    mockPassport,
    AllIds,
    new DefaultConfigStore({
      // No minimum age / no excluded countries — AK doesn't gate on
      // demographic disclosure; it only needs proof-of-human + uniqueness.
      // Tighten later if specific deployments require it.
      minimumAge: 0,
      excludedCountries: [],
      ofac: false,
    }),
    'hex', // userIdentifier is the EVM wallet address (hex)
  );

  return _verifier;
}
