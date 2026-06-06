/**
 * Stellar ChainAdapter (L3). U1 shipped address validation + explorer URLs; U2
 * wired indexReceipts; U3 wires the 8004 read/write paths (readAttestation,
 * readAttestations, publishAttestation) to the trionlabs/stellar-8004 client.
 * Functional factory — NO class (AK hard rule).
 */
import type { ChainAdapter, IndexRunResult, PublishResult } from './types';
import { runStellarIndexer } from '@/indexer/stellar-x402';
import {
  computeAttestationScore,
  getStellarRpc,
  type ComputeScoreArgs,
} from '@/integrations/erc8004-stellar';
import {
  publishStellarScore,
  getValidatorAddress,
  type PublishStellarScoreArgs,
} from '@/integrations/erc8004-stellar-publish';
import { getStellarAgentId } from '@/db/client'; // U1 column getter (walletsTable.stellar_agent_id)

// Stellar StrKey: G… Ed25519 public accounts are 56 chars, base32 (A–Z, 2–7).
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

/**
 * Pure resolver (injectable server) — unit-testable without DB. Maps an
 * agentId + validator-scoped on-chain summary to a 0–100 score; 0 when the
 * wallet has no registered agentId (badge-gated, no rpc round-trip).
 */
export async function resolveAttestationScore(a: ComputeScoreArgs): Promise<number> {
  return computeAttestationScore(a);
}

/**
 * Pure resolver (injectable deps) — unit-testable without DB. Badge-gated +
 * idempotent: skips (never mints) when agentId is null, skips when on-chain
 * score is within DELTA_THRESHOLD.
 */
export async function resolvePublish(a: PublishStellarScoreArgs): Promise<PublishResult> {
  return publishStellarScore(a);
}

export function makeStellarAdapter(): ChainAdapter {
  return {
    chain: 'stellar',

    validateAddress: (address) => STELLAR_ADDRESS_RE.test(address),
    normalizeAddress: (address) => address,

    // U2: Stellar USDC SAC transfer indexer. Reads the pubnet SAC via Soroban
    // RPC, attributes x402/MPP receipts, persists Tier-1 signals. Safe no-op
    // (0 fetched, no RPC call) until STELLAR_FACILITATORS/MPP recipients seed.
    async indexReceipts(opts?: { backfill?: boolean; limit?: number }): Promise<IndexRunResult> {
      return runStellarIndexer({ limit: opts?.limit });
    },

    async readAttestation(address): Promise<number> {
      const agentId = await getStellarAgentId(address); // null if unregistered
      return resolveAttestationScore({
        agentId,
        server: getStellarRpc(),
        validatorAddress: getValidatorAddress(),
      });
    },

    async readAttestations(addresses): Promise<Map<string, number>> {
      const out = new Map<string, number>();
      for (const addr of addresses) out.set(addr, await this.readAttestation(addr));
      return out;
    },

    async publishAttestation(address, score): Promise<PublishResult> {
      const agentId = await getStellarAgentId(address);
      return resolvePublish({
        score,
        agentId,
        validatorAddress: getValidatorAddress(),
        mode: 'execute',
      });
    },

    explorerTxUrl: (txId) => `https://stellar.expert/explorer/public/tx/${txId}`,
    explorerAddressUrl: (address) => `https://stellar.expert/explorer/public/account/${address}`,
  };
}
