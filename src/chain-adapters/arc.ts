/**
 * Arc ChainAdapter (Circle's USDC-native EVM L1 — chain #4). Folds over
 * erc8004-arc.ts (reads) + erc8004-arc-publish.ts (write) for ERC-8004
 * attestation, and arc-jobs.ts (ERC-8183 job-settlement indexer) for Tier-1
 * receipts. Identity-gated like Celo: a bare EVM address can't resolve an
 * agentId on the IdentityRegistry, so readAttestation returns 0 and
 * publishAttestation skips until the agent registers. NO class.
 */
import { isAddress } from 'viem';
import type { ChainAdapter, IndexRunResult, PublishResult } from './types';
import type { WalletScore } from '@/scoring/index';
import { aggregateFeedback } from '@/integrations/erc8004-arc';
import { runArcJobsIndexer } from '@/indexer/arc-jobs';

const TAG2 = 'agentkarma';

export function makeArcAdapter(): ChainAdapter {
  return {
    chain: 'arc',

    validateAddress: (address) => isAddress(address),
    normalizeAddress: (address) => address.toLowerCase(),

    // ERC-8183 job-settlement indexer. OPT-IN: no-op until ARC_JOBS_START_BLOCK
    // is configured (mirrors Celo's no-op + Stellar's empty-set guard), so the
    // keep-fresh cron never triggers an unbounded from-genesis backfill. Once
    // configured, runArcJobsIndexer paginates in <=10k-block windows, bounded
    // per run by its maxWindows cap.
    async indexReceipts(_opts?: { backfill?: boolean; limit?: number }): Promise<IndexRunResult> {
      if (!process.env.ARC_JOBS_START_BLOCK) {
        return { fetched: 0, inserted: 0, cursors: new Map() };
      }
      return runArcJobsIndexer();
    },

    // Reading by EVM address requires an agentId; absent a resolver here we
    // return 0 (no attestation). Agent-page reads that already hold an agentId
    // call aggregateFeedback directly. void to satisfy the no-unused-var lint.
    async readAttestation(_address: string): Promise<number> {
      void aggregateFeedback;
      return 0;
    },

    async readAttestations(addresses: string[]): Promise<Map<string, number>> {
      const out = new Map<string, number>();
      for (const addr of addresses) out.set(addr, await this.readAttestation(addr));
      return out;
    },

    async publishAttestation(address: string, _score: WalletScore): Promise<PublishResult> {
      // Identity gate: no agentId resolvable from the bare address → skip,
      // badge-gated until the agent is registered. Mirrors erc8004-arc-publish
      // precondition (caller must supply a registered agentId).
      void TAG2;
      return { address, dryRun: true, skipped: true, reason: 'no_arc_agent_id' };
    },

    explorerTxUrl: (txId) => `https://testnet.arcscan.app/tx/${txId}`,
    explorerAddressUrl: (address) => `https://testnet.arcscan.app/address/${address}`,
  };
}
