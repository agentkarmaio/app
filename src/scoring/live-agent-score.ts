/**
 * Live score bundle for a single agent — the shared wallet-score assembly
 * (src/scoring/wallet-score.ts), extracted from
 * the /agent/[wallet] route so the cache layer (src/db/cached.ts) can wrap it
 * per-wallet. Every consumer of this bundle (header chips, score ring,
 * breakdown, summary) reads the SAME computation, so they can never disagree.
 *
 * JSON-safe by construction: WalletScore.lastActive (a Date) is carried as an
 * ISO string so the result can cross the unstable_cache boundary intact.
 */

import { getArcMainnetReceiptEvents } from '@/db/client';
import type { WalletScore } from '@/scoring/index';
import { computeAutonomy, type AutonomyResult } from '@/scoring/autonomy';
import { gatherScoreInputs, scoreFromInputs } from './wallet-score';
import type { Chain, SignalEvent } from '@/db/schema';
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

/** Arc scoring over an already-read receipt window, so callers that also
 *  display the window (the profile) read it once. */
export function arcMainnetBundleFromWindow(
  wallet: string, window: { events: readonly SignalEvent[]; saturated: boolean },
): AgentLiveBundle {
  const receiptScore = computeArcMainnetReceiptScore(wallet, window.events, { saturated: window.saturated });
  const unique = new Map(receiptScore.observations.map(row => [row.rawTxHash, row]));
  const autonomy = unique.size ? computeAutonomy([...unique.values()].map(row => ({
    timestamp: row.timestamp, counterparty: row.counterparty,
  }))) : null;
  return { feedback: EMPTY_FEEDBACK, live: null, manifestValue: null,
    txCount: receiptScore.txCount, autonomy, receiptScore };
}

export async function computeAgentLiveBundle(wallet: string, chain: Chain = 'solana'): Promise<AgentLiveBundle> {
  if (chain === 'arc-mainnet') {
    return arcMainnetBundleFromWindow(wallet, await getArcMainnetReceiptEvents(wallet, ARC_MAINNET_RECEIPT_LIMIT));
  }
  // The shared assembly every surface uses — the profile shows the same score
  // the API serves and the leaderboard stores (signal events + Agent Bond were
  // missing here, and the 10000-tx window differed from everyone else's).
  const inputs = await gatherScoreInputs(wallet, chain);
  const { feedback, manifestValue, autonomy } = inputs;
  const live = scoreFromInputs(inputs);
  if (!live) {
    return { feedback, live: null, manifestValue, txCount: 0, autonomy: null };
  }

  return {
    feedback,
    live: { ...live, lastActive: live.lastActive.toISOString() },
    manifestValue,
    txCount: inputs.transactions.length,
    autonomy,
  };
}
