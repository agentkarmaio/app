/**
 * Arc ChainAdapter (Circle's USDC-native EVM L1 — chain #4). Folds over
 * erc8004-arc.ts (reads) + erc8004-arc-publish.ts (write) for ERC-8004
 * attestation, and arc-jobs.ts (ERC-8183 job-settlement indexer) for Tier-1
 * receipts. Identity-gated like Celo: a bare EVM address can't resolve an
 * agentId on the IdentityRegistry, so readAttestation returns 0 and
 * publishAttestation skips until the agent registers. NO class.
 */
import { isAddress } from "viem";
import type { ChainAdapter, IndexRunResult, PublishResult } from "./types";
import { explorerAddressUrl, explorerTxUrl } from "@/lib/explorer-urls";
import type { WalletScore } from "@/scoring/index";
import { aggregateFeedback } from "@/integrations/erc8004-arc";

const TAG2 = "agentkarma";

export function makeArcAdapter(): ChainAdapter {
  return {
    chain: "arc",

    validateAddress: (address) => isAddress(address),
    normalizeAddress: (address) => address.toLowerCase(),

    async indexReceipts(): Promise<IndexRunResult> {
      throw new Error('arc_testnet_retired');
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
      for (const addr of addresses)
        out.set(addr, await this.readAttestation(addr));
      return out;
    },

    async publishAttestation(
      address: string,
      _score: WalletScore,
    ): Promise<PublishResult> {
      // Historical testnet profiles remain readable; publication is retired.
      void TAG2;
      return {
        address,
        dryRun: true,
        skipped: true,
        reason: "arc_testnet_retired",
      };
    },

    explorerTxUrl: (txId) => explorerTxUrl("arc", txId),
    explorerAddressUrl: (address) => explorerAddressUrl("arc", address),
  };
}
