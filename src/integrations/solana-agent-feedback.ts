/**
 * Solana ERC-8004 feedback, read per agent ASSET (the Core NFT pubkey) — the
 * only key 8004-solana's giveFeedback / readAllFeedback accept. A scored wallet
 * maps to ONE canonical asset (its oldest registration) via the
 * `erc8004_agents` mirror (getSolanaAgentAsset), never by using the wallet
 * itself as the asset. One asset bounds AK's writes and reads per wallet.
 *
 * AK's own records are recognised by CLIENT (AK's publisher pubkey), never by
 * tag alone: anyone can write a `karma_score` record.
 *
 * Two views over the same records, kept apart on purpose:
 *   thirdPartyFeedbackScore — Tier-1 input: everyone's feedback EXCEPT AK's own
 *                              published score (AK must never read itself back
 *                              as receipt-grade evidence).
 *   ownPublishedScore       — AK's last `karma_score` on the asset, for the
 *                              publish path's drift check only.
 *
 * getSummary().averageScore is not used: it is an ATOM quality stat (it reads 0
 * for an asset whose records score [100, 100, 0]), not a score average, and it
 * spans all clients including AK.
 */

import type { SolanaSDK } from '8004-solana';
import { PublicKey } from '@solana/web3.js';

/** tag1 values AK itself writes on Solana — excluded from Tier-1 reads. */
export const AK_SOLANA_TAG1 = 'karma_score';

export interface AgentFeedback {
  /** Pubkey of the wallet that wrote the record. */
  client: string;
  tag1: string;
  /** 0–100, or null when the record carries no score. */
  score: number | null;
  revoked: boolean;
  feedbackIndex: bigint;
}

/** Everyone's feedback except AK's (by client) and karma_score look-alikes. */
export function thirdPartyFeedbackScore(records: readonly AgentFeedback[], akClient: string | null): number {
  const scores = records
    .filter((r) => !r.revoked && r.client !== akClient && r.tag1 !== AK_SOLANA_TAG1 && typeof r.score === 'number')
    .map((r) => r.score as number);
  if (scores.length === 0) return 0;
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  return Math.min(Math.max(avg / 100, 0), 1);
}

/** AK's latest karma_score, written by AK's own publisher key. */
export function ownPublishedScore(records: readonly AgentFeedback[], akClient: string | null): number | null {
  if (!akClient) return null;
  let latest: AgentFeedback | null = null;
  for (const r of records) {
    if (r.revoked || r.client !== akClient || r.tag1 !== AK_SOLANA_TAG1 || typeof r.score !== 'number') continue;
    if (!latest || r.feedbackIndex > latest.feedbackIndex) latest = r;
  }
  return latest?.score ?? null;
}

/** All feedback records on one asset, in the shape the pure views take. */
export async function readAgentFeedbackVia(sdk: SolanaSDK, asset: string): Promise<AgentFeedback[]> {
  const rows = await sdk.readAllFeedback(new PublicKey(asset));
  return rows.map((r) => ({
    client: r.client.toBase58(),
    tag1: r.tag1,
    score: r.score ?? null,
    revoked: Boolean(r.revoked ?? r.isRevoked),
    feedbackIndex: BigInt(r.feedbackIndex),
  }));
}
