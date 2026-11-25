/**
 * Solana ChainAdapter (L1) — thin fold over the existing Solana integration +
 * indexer. Does NOT reimplement: delegates to attestation.ts / erc8004.ts /
 * indexer/index.ts. Functional factory — NO class.
 */
import { PublicKey } from '@solana/web3.js';
import type { ChainAdapter, IndexRunResult, PublishResult } from './types';
import { explorerAddressUrl, explorerTxUrl } from '@/lib/explorer-urls';
import type { WalletScore } from '@/scoring/index';
import { readAgentFeedback } from '@/integrations/attestation';
import { initSDKFromEnv, writeFeedback } from '@/integrations/erc8004';
import { ownPublishedScore, type AgentFeedback } from '@/integrations/solana-agent-feedback';
import { getSolanaAgentAssets } from '@/db/client';
import { runIndexer } from '@/indexer';

export interface SolanaAdapterDeps {
  /** 8004 agent assets the wallet controls (erc8004_agents mirror). */
  findAgentAssets: (wallet: string) => Promise<string[]>;
  writeFeedback: (asset: string, score: WalletScore) => Promise<{ signature?: string; dryRun: boolean }>;
  readAgentFeedback: (asset: string) => Promise<AgentFeedback[]>;
}

const defaultDeps: SolanaAdapterDeps = {
  findAgentAssets: getSolanaAgentAssets,
  writeFeedback: (asset, score) => writeFeedback(initSDKFromEnv(), asset, score),
  readAgentFeedback,
};

export function makeSolanaAdapter(deps: SolanaAdapterDeps = defaultDeps): ChainAdapter {
  // AK's own last published karma_score across the wallet's agent assets —
  // the publish drift check, same contract as the Stellar adapter.
  const readOwn = async (address: string): Promise<number> => {
    for (const asset of await deps.findAgentAssets(address)) {
      const own = ownPublishedScore(await deps.readAgentFeedback(asset));
      if (own != null) return own;
    }
    return 0;
  };

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

    readAttestation: readOwn,
    async readAttestations(addresses) {
      const out = new Map<string, number>();
      for (const addr of addresses) out.set(addr, await readOwn(addr));
      return out;
    },

    async publishAttestation(address: string, score: WalletScore): Promise<PublishResult> {
      // Solana 8004 feedback targets the agent's Core asset. A wallet with no
      // registered agent has nowhere to receive a karma_score — writing to the
      // wallet as if it were an asset is what kept every publish from landing.
      const assets = await deps.findAgentAssets(address);
      if (assets.length === 0) {
        return { address, dryRun: false, skipped: true, reason: 'no 8004 agent identity for this wallet' };
      }
      const txIds: string[] = [];
      let dryRun = false;
      for (const asset of assets) {
        const r = await deps.writeFeedback(asset, score);
        if (r.dryRun) dryRun = true;
        if (r.signature) txIds.push(r.signature);
      }
      return { address, dryRun, skipped: false, txId: txIds.join(',') || undefined };
    },

    explorerTxUrl: (txId) => explorerTxUrl('solana', txId),
    explorerAddressUrl: (address) => explorerAddressUrl('solana', address),
  };
}
