'use client';

/**
 * useStellarClaimWallet — Stellar wallet connect + claim-challenge signing for
 * the agent claim flow (chain #3 / L3). Functional hook (NO class), interaction
 * primitive → "use client" justified.
 *
 * Coexists with the Solana wallet provider: Stellar Wallets Kit holds its own
 * static module registry and needs no global React provider, so app/layout.tsx
 * is untouched.
 *
 * Connect path: Stellar Wallets Kit authModal() → returns the selected wallet's
 * G… address (kit static API, v2.x).
 * Sign path: @stellar/freighter-api signMessage over the canonical challenge.
 * The challenge string is byte-identical to the Solana path so one signing
 * contract spans every chain (see src/components/karma/claim-banner.tsx:65).
 */

import { useCallback, useEffect, useState } from 'react';
import { StellarWalletsKit, Networks } from '@creit.tech/stellar-wallets-kit';
import { FreighterModule } from '@creit.tech/stellar-wallets-kit/modules/freighter';
import { signMessage } from '@stellar/freighter-api';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in use-stellar-claim-wallet.test.ts)
// ---------------------------------------------------------------------------

/**
 * Canonical claim challenge. MUST stay byte-identical to the Solana path
 * (src/components/karma/claim-banner.tsx + src/app/api/agent/claim/route.ts)
 * so the server verify accepts every chain through one format.
 */
export function buildStellarClaimChallenge(address: string, timestampMs: number): string {
  return `AgentKarma: Claim wallet ${address} at ${timestampMs}`;
}

/**
 * Normalize whatever carrier @stellar/freighter-api returns for `signedMessage`
 * into canonical lowercase hex (the wire format the server verify expects).
 *
 * Freighter's return shape is version/wallet-dependent (the type is
 * `Buffer | string | null`): V3-era wallets hand back raw bytes (Buffer /
 * Uint8Array), V4 wallets a base64 string. A hex string (already canonical)
 * also passes through. `null` / empty means the user rejected or the extension
 * failed — raise, never silently sign-fail.
 *
 * The exact live encoding is pinned manually in-browser (see plan Task 53);
 * this accepts all documented carriers so the path is robust to that drift.
 */
export function normalizeFreighterSignatureToHex(
  signedMessage: Buffer | Uint8Array | string | null | undefined,
): string {
  if (signedMessage == null) {
    throw new Error('Freighter returned no signature');
  }

  if (typeof signedMessage !== 'string') {
    // Buffer / Uint8Array → hex
    return Buffer.from(signedMessage).toString('hex');
  }

  if (signedMessage.length === 0) {
    throw new Error('Freighter returned no signature');
  }

  // Already canonical hex (even length, hex alphabet) → just lowercase it.
  if (/^[0-9a-fA-F]+$/.test(signedMessage) && signedMessage.length % 2 === 0) {
    return signedMessage.toLowerCase();
  }

  // Otherwise treat it as base64 (Freighter V4 carrier).
  return Buffer.from(signedMessage, 'base64').toString('hex');
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface StellarSignedClaim {
  /** G… Ed25519 public key that signed. */
  address: string;
  /** The canonical challenge that was signed (echoed to the server). */
  message: string;
  /** Detached Ed25519 signature, lowercase hex. */
  signatureHex: string;
}

// One-time static registration of the kit's modules. Stellar Wallets Kit keeps
// a process-wide static module registry; init must run exactly once before any
// authModal/getAddress call. We register the Freighter (G… Ed25519) module on
// the public network — C… smart-wallet contracts are excluded in v1.
let _kitReady = false;
function ensureKitInit(): void {
  if (_kitReady) return;
  StellarWalletsKit.init({
    network: Networks.PUBLIC,
    modules: [new FreighterModule()],
  });
  _kitReady = true;
}

export function useStellarClaimWallet() {
  const [address, setAddress] = useState<string | null>(null);

  useEffect(() => {
    ensureKitInit();
  }, []);

  /**
   * Open the wallet picker, connect, and return the selected G… address.
   * Returns null if the user closes the modal without picking a wallet.
   */
  const connect = useCallback(async (): Promise<string | null> => {
    ensureKitInit();
    try {
      const { address: picked } = await StellarWalletsKit.authModal();
      setAddress(picked);
      return picked;
    } catch {
      // User closed the modal / declined — surface as "not connected".
      return null;
    }
  }, []);

  const disconnect = useCallback(() => setAddress(null), []);

  /**
   * Sign the canonical claim challenge for `walletAddress` via Freighter.
   * Returns the signature as lowercase hex so the server verify path
   * (nacl.sign.detached.verify) can decode it uniformly.
   */
  const signChallenge = useCallback(
    async (walletAddress: string): Promise<StellarSignedClaim> => {
      const timestampMs = Date.now();
      const message = buildStellarClaimChallenge(walletAddress, timestampMs);

      const result = await signMessage(message, {
        address: walletAddress,
        networkPassphrase: Networks.PUBLIC,
      });
      if (result.error) {
        throw new Error(`Freighter signMessage failed: ${result.error.message}`);
      }

      const signatureHex = normalizeFreighterSignatureToHex(result.signedMessage);
      const publicKey = result.signerAddress || walletAddress;
      return { address: publicKey, message, signatureHex };
    },
    [],
  );

  return {
    address,
    connected: address != null,
    connect,
    disconnect,
    /** @returns { signature(hex), publicKey(G…) } via the StellarSignedClaim shape. */
    signChallenge,
  };
}
