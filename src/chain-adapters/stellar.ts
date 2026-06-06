/**
 * Stellar ChainAdapter (L3) — scaffold. U1 ships address validation + explorer
 * URLs; receipt indexing (U2), 8004 reads/writes (U3) throw until implemented.
 * Functional factory — NO class (AK hard rule).
 */
import type { ChainAdapter, IndexRunResult, PublishResult } from './types';
import type { WalletScore } from '@/scoring/index';

// Stellar StrKey: G… Ed25519 public accounts are 56 chars, base32 (A–Z, 2–7).
// U3/U4 replaces this with StrKey.isValidEd25519PublicKey from @stellar/stellar-sdk.
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

function notImplemented(method: string): never {
  throw new Error(`StellarAdapter.${method} not yet implemented`);
}

export function makeStellarAdapter(): ChainAdapter {
  return {
    chain: 'stellar',

    validateAddress: (address) => STELLAR_ADDRESS_RE.test(address),
    normalizeAddress: (address) => address,

    async indexReceipts(_opts?: { backfill?: boolean; limit?: number }): Promise<IndexRunResult> {
      notImplemented('indexReceipts');
    },

    async readAttestation(_address: string): Promise<number> {
      notImplemented('readAttestation');
    },

    async readAttestations(addresses: string[]): Promise<Map<string, number>> {
      const out = new Map<string, number>();
      for (const addr of addresses) out.set(addr, await this.readAttestation(addr));
      return out;
    },

    async publishAttestation(_address: string, _score: WalletScore): Promise<PublishResult> {
      notImplemented('publishAttestation');
    },

    explorerTxUrl: (txId) => `https://stellar.expert/explorer/public/tx/${txId}`,
    explorerAddressUrl: (address) => `https://stellar.expert/explorer/public/account/${address}`,
  };
}
