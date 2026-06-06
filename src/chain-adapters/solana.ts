/**
 * Solana ChainAdapter (L1) — thin fold over the existing Solana integration +
 * indexer. Does NOT reimplement: delegates to attestation.ts / erc8004.ts /
 * indexer/index.ts. Functional factory — NO class.
 */
import { PublicKey } from '@solana/web3.js';
import type { ChainAdapter, IndexRunResult, PublishResult } from './types';
import type { WalletScore } from '@/scoring/index';
import { readAttestation as solReadAttestation, readAttestations as solReadAttestations } from '@/integrations/attestation';
import { initSDKFromEnv, writeFeedback } from '@/integrations/erc8004';
import { runIndexer } from '@/indexer';

export function makeSolanaAdapter(): ChainAdapter {
  return {
    chain: 'solana',

    validateAddress: (address) => {
      try { new PublicKey(address); return true; } catch { return false; }
    },

    normalizeAddress: (address) => new PublicKey(address).toBase58(),

    async indexReceipts(opts?: { backfill?: boolean; limit?: number }): Promise<IndexRunResult> {
      const res = await runIndexer(opts?.limit ?? 100, { backfill: opts?.backfill });
      // runIndexer manages its own per-facilitator cursors internally; expose
      // the aggregate counts on the shared contract. cursors map stays empty
      // because Solana cursoring is internal to runIndexer (unchanged behavior).
      return { fetched: res.fetched, inserted: res.inserted, cursors: new Map() };
    },

    readAttestation: (address) => solReadAttestation(address),
    readAttestations: (addresses) => solReadAttestations(addresses),

    async publishAttestation(address: string, score: WalletScore): Promise<PublishResult> {
      const sdk = initSDKFromEnv();
      const r = await writeFeedback(sdk, address, score);
      return { address, txId: r.signature, dryRun: r.dryRun, skipped: false };
    },

    explorerTxUrl: (txId) => `https://solscan.io/tx/${txId}`,
    explorerAddressUrl: (address) => `https://solscan.io/account/${address}`,
  };
}
