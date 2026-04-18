/**
 * Signal builders — translate raw observations into `signal_events` rows.
 *
 * Phase G1: x402 payments emit a Tier 2 behavioral signal. A payment without
 * any follow-up feedback is a behavioral fact (the wallet moved USDC through
 * a facilitator). The pairing with a signed delivery feedback (Tier 1) is
 * emitted separately by the feedback endpoint.
 */

import type { Transaction } from '@/db/schema';
import type { InsertSignalEventInput } from '@/db/client';
import type { CadenceResult } from './cadence';

/**
 * Sentinel tx_ref for aggregate signals (cadence, program breadth, etc.)
 * that summarize a wallet's state rather than a single event. One row per
 * (agent_wallet, kind) — the `uniq_signal_events_dedup` unique index turns
 * re-emissions into idempotent overwrites.
 */
export const AGGREGATE_TX_REF = 'aggregate';

/**
 * Build the Tier 2 signal for a single x402 payment.
 * `signed_by` = facilitator address (the entity that routed/coordinated the tx).
 * `value` = normalized amount (USDC / 1000), capped at 1.0 — contributes to
 * volume weighting without letting a single whale payment dominate.
 */
export function buildX402PaymentSignal(tx: Transaction): InsertSignalEventInput {
  const normalizedAmount = Math.min(Number(tx.amount) / 1000, 1);
  return {
    agentWallet: tx.wallet_address,
    tier: 2,
    kind: 'x402_payment',
    face: 'provider', // matches legacy treatment; re-evaluated in G1b
    weight: 1.0,
    value: normalizedAmount,
    signedBy: tx.facilitator,
    txRef: tx.tx_signature,
    observedAt: tx.timestamp,
    payload: { amount: Number(tx.amount), success: tx.success },
  };
}

export function buildX402PaymentSignals(
  txs: Pick<Transaction, 'wallet_address' | 'facilitator' | 'amount' | 'timestamp' | 'success' | 'tx_signature'>[],
): InsertSignalEventInput[] {
  return txs.map((tx) => buildX402PaymentSignal(tx as Transaction));
}

/**
 * Build the Tier 2 cadence signal for a wallet. `value` = automationScore, so
 * downstream scoring can aggregate without re-parsing the payload.
 */
export function buildCadenceSignal(
  walletAddress: string,
  cadence: CadenceResult,
): InsertSignalEventInput {
  return {
    agentWallet: walletAddress,
    tier: 2,
    kind: 'cadence',
    face: 'provider',
    weight: 1.0,
    value: cadence.automationScore,
    txRef: AGGREGATE_TX_REF,
    payload: {
      uniformity: cadence.uniformity,
      regularity: cadence.regularity,
      histogram: cadence.histogram,
      txCount: cadence.txCount,
    },
  };
}

/**
 * Build the Tier 3 manifest signal for a wallet. Unverified declared manifests
 * land at 0.5, owner-signed (wallet-matching) manifests at 1.0. Sub-weights
 * reserved for Phase H2+ (DNS proof, GitHub proof, cross-chain 8004 import).
 */
export function buildManifestSignal(
  walletAddress: string,
  opts: { sourceType: string; verified: boolean; url?: string | null },
): InsertSignalEventInput {
  return {
    agentWallet: walletAddress,
    tier: 3,
    kind: 'manifest',
    face: 'provider',
    weight: 1.0,
    value: opts.verified ? 1.0 : 0.5,
    txRef: AGGREGATE_TX_REF,
    payload: {
      sourceType: opts.sourceType,
      verified: opts.verified,
      url: opts.url ?? null,
    },
  };
}
