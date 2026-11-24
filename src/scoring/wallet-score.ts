/**
 * The one way to score a wallet.
 *
 * Every surface that shows, stores or publishes a wallet's karma (v2 API, MCP /
 * A2A resolver, profile page, badge, legacy score route, rescore queue, manual
 * refresh, on-chain publish) used to assemble `calculateScore` inputs by hand.
 * They drifted: different tx windows (1000 / 5000 / 10000), feedback missing
 * from the persisted score, signal events and Agent Bond missing from the
 * profile, transactions-only on the publish path. The same wallet had several
 * "current" scores and the on-chain one matched none of them.
 *
 * Two layers, so the math stays pure and recomputable:
 *   gatherScoreInputs — reads every input (injectable deps)
 *   scoreFromInputs   — pure: inputs + asOf → WalletScore
 *
 * Reads that fail degrade to "absent" so read surfaces stay up, but every such
 * failure is named in `degraded`. A path that PERSISTS or PUBLISHES a score
 * must refuse to when `degraded` is non-empty: a score computed from an input
 * we could not read is not the wallet's score.
 */

import type { Chain, SignalEvent, Transaction } from '@/db/schema';
import {
  DEFAULT_TX_WINDOW,
  getAgentBondInput,
  getFeedbackSummary,
  getLatestSignalValues,
  getRecentTransactionsForWallet,
  getSignalEventsForWallet,
} from '@/db/client';
import { readAttestationsDetailed } from '@/integrations/attestation';
import { STELLAR_TESTNET_AGENT_BOND } from '@/integrations/stellar-config';
import type { AgentBondInput } from './agent-bond';
import { computeAutonomy, type AutonomyResult } from './autonomy';
import { computeCadence } from './cadence';
import { calculateScore, type WalletScore } from './index';

/** Newest-N transactions every surface scores over. Age and recency read the
 *  window's oldest/newest tx, so a different N is a different score. */
export const SCORE_TX_WINDOW = DEFAULT_TX_WINDOW;

/** Signal events read per wallet (bonds / heartbeat / will live here). */
export const SCORE_SIGNAL_EVENT_LIMIT = 200;

export interface FeedbackSummary {
  total: number;
  delivered: number;
  failed: number;
  deliveryRate: number;
}

export type ScoreInput = 'attestation' | 'feedback' | 'manifest' | 'signalEvents' | 'agentBond';

export interface ScoreInputs {
  wallet: string;
  chain: Chain;
  transactions: Transaction[];
  /** 8004 attestation, normalized 0–1. Solana only; 0 elsewhere. */
  attestation: number;
  feedback: FeedbackSummary;
  manifestValue: number | null;
  signalEvents: SignalEvent[];
  agentBond: AgentBondInput | null;
  cadence: ReturnType<typeof computeCadence>;
  autonomy: AutonomyResult | null;
  /** Inputs that could not be read and were treated as absent. */
  degraded: ScoreInput[];
}

export interface ScoreInputDeps {
  getTransactions: (wallet: string, limit: number, chain: Chain) => Promise<Transaction[]>;
  readAttestation: (wallet: string) => Promise<{ score: number; unavailable: boolean }>;
  getFeedbackSummary: (wallet: string, chain: Chain) => Promise<FeedbackSummary>;
  getManifestValue: (wallet: string, chain: Chain) => Promise<number | null>;
  getSignalEvents: (wallet: string, limit: number, chain: Chain) => Promise<SignalEvent[]>;
  getAgentBond: (wallet: string, chain: Chain, nowMs: number) => Promise<AgentBondInput | null>;
}

export const defaultScoreInputDeps: ScoreInputDeps = {
  getTransactions: (wallet, limit, chain) => getRecentTransactionsForWallet(wallet, limit, chain),
  readAttestation: async (wallet) => {
    const batch = await readAttestationsDetailed([wallet]);
    return { score: batch.scores.get(wallet) ?? 0, unavailable: batch.unavailable };
  },
  getFeedbackSummary: (wallet, chain) => getFeedbackSummary(wallet, chain),
  getManifestValue: async (wallet, chain) =>
    (await getLatestSignalValues([wallet], 'manifest', chain)).get(wallet) ?? null,
  getSignalEvents: (wallet, limit, chain) => getSignalEventsForWallet(wallet, limit, chain),
  getAgentBond: (wallet, chain, nowMs) =>
    getAgentBondInput(wallet, chain, STELLAR_TESTNET_AGENT_BOND.contractId, nowMs),
};

const EMPTY_FEEDBACK: FeedbackSummary = { total: 0, delivered: 0, failed: 0, deliveryRate: 0 };

export interface GatherOptions {
  /** Instant the score is evaluated at (also bounds the Agent Bond window). */
  asOf?: Date;
  /** Pre-read attestation (batch callers); skips the per-wallet read. */
  attestation?: { score: number; unavailable: boolean };
}

export async function gatherScoreInputs(
  wallet: string,
  chain: Chain,
  opts: GatherOptions = {},
  deps: ScoreInputDeps = defaultScoreInputDeps,
): Promise<ScoreInputs> {
  const nowMs = (opts.asOf ?? new Date()).getTime();
  const degraded: ScoreInput[] = [];
  const soft = async <T>(name: ScoreInput, read: () => Promise<T>, absent: T): Promise<T> => {
    try {
      return await read();
    } catch (err) {
      degraded.push(name);
      console.warn(`[score-inputs] ${name} read failed for ${chain}:${wallet}:`, err instanceof Error ? err.message : err);
      return absent;
    }
  };

  // Only Solana carries a Tier-1 8004 attestation input. Elsewhere AK's own
  // published aggregate is readable but must never be recycled into Tier 1.
  const readAttestation = (): Promise<{ score: number; unavailable: boolean }> =>
    chain !== 'solana'
      ? Promise.resolve({ score: 0, unavailable: false })
      : opts.attestation
        ? Promise.resolve(opts.attestation)
        : deps.readAttestation(wallet);

  // Transactions are the score; a failed read is an error, not a degraded input.
  const [transactions, attestationRead, feedback, manifestValue, signalEvents, agentBond] = await Promise.all([
    deps.getTransactions(wallet, SCORE_TX_WINDOW, chain),
    soft('attestation', readAttestation, { score: 0, unavailable: true }),
    soft('feedback', () => deps.getFeedbackSummary(wallet, chain), EMPTY_FEEDBACK),
    soft('manifest', () => deps.getManifestValue(wallet, chain), null),
    soft('signalEvents', () => deps.getSignalEvents(wallet, SCORE_SIGNAL_EVENT_LIMIT, chain), [] as SignalEvent[]),
    soft('agentBond', () => deps.getAgentBond(wallet, chain, nowMs), null),
  ]);
  if (attestationRead.unavailable && !degraded.includes('attestation')) degraded.push('attestation');

  const hasTxs = transactions.length > 0;
  return {
    wallet,
    chain,
    transactions,
    attestation: attestationRead.score,
    feedback,
    manifestValue,
    signalEvents,
    agentBond,
    cadence: hasTxs ? computeCadence(transactions.map((tx) => new Date(tx.timestamp))) : null,
    autonomy: hasTxs
      ? computeAutonomy(transactions.map((tx) => ({ timestamp: tx.timestamp, counterparty: tx.facilitator })))
      : null,
    degraded,
  };
}

/** Pure: same inputs + same asOf → same score. Null when there is nothing to score. */
export function scoreFromInputs(inputs: ScoreInputs, opts: { asOf?: Date } = {}): WalletScore | null {
  if (inputs.transactions.length === 0) return null;
  return calculateScore(
    inputs.transactions,
    inputs.attestation,
    inputs.feedback.deliveryRate,
    inputs.feedback.total,
    inputs.cadence?.automationScore ?? null,
    inputs.manifestValue,
    null,
    inputs.signalEvents,
    inputs.agentBond,
    { asOf: opts.asOf },
  );
}
