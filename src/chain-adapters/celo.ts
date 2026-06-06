/**
 * Celo ChainAdapter (L2) — fold over erc8004-celo.ts (reads) +
 * erc8004-celo-publish.ts (write). Identity-gated: publishing requires a known
 * agentId on the IdentityRegistry. An EVM address alone can't resolve one here,
 * so publishAttestation skips (mirrors the precedent Stellar/U3 follows). NO class.
 */
import { isAddress } from 'viem';
import type { ChainAdapter, IndexRunResult, PublishResult } from './types';
import type { WalletScore } from '@/scoring/index';
import { aggregateFeedback } from '@/integrations/erc8004-celo';

const TAG2 = 'agentkarma';

export function makeCeloAdapter(): ChainAdapter {
  return {
    chain: 'celo',

    validateAddress: (address) => isAddress(address),
    normalizeAddress: (address) => address.toLowerCase(),

    async indexReceipts(_opts?: { backfill?: boolean; limit?: number }): Promise<IndexRunResult> {
      // Celo receipt indexing is not part of L3 parity work — no-op run.
      return { fetched: 0, inserted: 0, cursors: new Map() };
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
      // badge-gated until the agent is registered. Mirrors erc8004-celo-publish
      // precondition (caller must supply a registered agentId).
      void TAG2;
      return { address, dryRun: true, skipped: true, reason: 'no_celo_agent_id' };
    },

    explorerTxUrl: (txId) => `https://celoscan.io/tx/${txId}`,
    explorerAddressUrl: (address) => `https://celoscan.io/address/${address}`,
  };
}
