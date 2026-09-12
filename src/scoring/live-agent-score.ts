/**
 * Live full-history score bundle for a single agent — the same math
 * /api/score/refresh uses (cap 10000 txs, same tier gating), extracted from
 * the /agent/[wallet] route so the cache layer (src/db/cached.ts) can wrap it
 * per-wallet. Every consumer of this bundle (header chips, score ring,
 * breakdown, summary) reads the SAME computation, so they can never disagree.
 *
 * JSON-safe by construction: WalletScore.lastActive (a Date) is carried as an
 * ISO string so the result can cross the unstable_cache boundary intact.
 */

import { getTransactions, getFeedbackSummary, getLatestSignalValues, getArcMainnetReceiptEvents } from '@/db/client';
import { calculateScore, type WalletScore } from '@/scoring/index';
import { computeCadence } from '@/scoring/cadence';
import { computeAutonomy, type AutonomyResult } from '@/scoring/autonomy';
import { readAttestation } from '@/integrations/attestation';
import type { Chain } from '@/db/schema';
import { ARC_MAINNET_RECEIPT_LIMIT, computeArcMainnetReceiptScore, type ArcMainnetReceiptScore } from './arc-mainnet-receipts';

export interface FeedbackSummaryLite {
  total: number;
  delivered: number;
  failed: number;
  deliveryRate: number;
}

/** WalletScore with the one non-JSON field (lastActive: Date) as ISO string. */
export type WalletScoreJson = Omit<WalletScore, 'lastActive'> & { lastActive: string };

export interface AgentLiveBundle {
  feedback: FeedbackSummaryLite;
  live: WalletScoreJson | null;
  manifestValue: number | null;
  txCount: number;
  autonomy: AutonomyResult | null;
  /** Mainnet uses observed transfer faces, whose metrics differ from x402. */
  receiptScore?: ArcMainnetReceiptScore;
}

const EMPTY_FEEDBACK: FeedbackSummaryLite = { total: 0, delivered: 0, failed: 0, deliveryRate: 0 };

export async function computeAgentLiveBundle(wallet: string, chain: Chain = 'solana'): Promise<AgentLiveBundle> {
  if (chain === 'arc-mainnet') {
    const window = await getArcMainnetReceiptEvents(wallet, ARC_MAINNET_RECEIPT_LIMIT);
    const receiptScore = computeArcMainnetReceiptScore(wallet, window.events, { saturated: window.saturated });
    const unique = new Map(receiptScore.observations.map(row => [row.rawTxHash, row]));
    const autonomy = unique.size ? computeAutonomy([...unique.values()].map(row => ({
      timestamp: row.timestamp, counterparty: row.counterparty,
    }))) : null;
    return { feedback: EMPTY_FEEDBACK, live: null, manifestValue: null,
      txCount: receiptScore.txCount, autonomy, receiptScore };
  }
  const [feedback, txs, attestation, manifestMap] = await Promise.all([
    getFeedbackSummary(wallet, chain).catch(() => EMPTY_FEEDBACK),
    getTransactions(wallet, 10000, 0, chain),
    chain === 'solana' ? readAttestation(wallet).catch(() => 0) : Promise.resolve(0),
    getLatestSignalValues([wallet], 'manifest', chain).catch(() => new Map<string, number>()),
  ]);
  const manifestValue = manifestMap.get(wallet) ?? null;

  if (txs.length === 0) {
    return { feedback, live: null, manifestValue, txCount: 0, autonomy: null };
  }

  const cadence = computeCadence(txs.map((tx) => new Date(tx.timestamp)));
  const autonomy = computeAutonomy(
    txs.map((tx) => ({ timestamp: tx.timestamp, counterparty: tx.facilitator })),
  );
  const live = calculateScore(
    txs, attestation, feedback.deliveryRate, feedback.total,
    cadence?.automationScore ?? null,
    manifestValue,
  );

  return {
    feedback,
    live: { ...live, lastActive: live.lastActive.toISOString() },
    manifestValue,
    txCount: txs.length,
    autonomy,
  };
}
