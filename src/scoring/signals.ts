/**
 * Signal builders — translate raw observations into `signal_events` rows.
 *
 * Phase G1: x402 payments emit a Tier 2 behavioral signal. A payment without
 * any follow-up feedback is a behavioral fact (the wallet moved USDC through
 * a facilitator). The pairing with a signed delivery feedback (Tier 1) is
 * emitted separately by the feedback endpoint.
 *
 * pay.sh sprint A1 (2026-05-06): pay.sh-routed payments emit a Tier 1
 * `paysh_routed` signal — the operator's fee-payer signature on the
 * multi-split settlement is itself an implicit, non-repudiable delivery
 * attestation. See docs/SIGNAL-ARCHITECTURE.md §"pay.sh and operator-attested
 * settlement" for the full reasoning.
 */

import type { Transaction, KarmaFace } from '@/db/schema';
import type { InsertSignalEventInput } from '@/db/client';
import type { CadenceResult } from './cadence';
import type { AutonomyResult } from './autonomy';

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
 * Build the Tier 1 `paysh_routed` signal for a single pay.sh-routed payment.
 *
 * `signed_by` = pay.sh operator address (the gateway whose feePayer signed
 * the multi-split settlement — the implicit attester). `value = 1.0` because
 * a pay.sh-routed broadcast is a max-strength receipt-gated attestation; we
 * do not down-weight by amount the way Tier 2 x402 does.
 *
 * Idempotent: the unique index on (agent_wallet, kind, tx_ref) makes
 * re-emission a no-op so the indexer + backfill can both run.
 */
export interface PayshRoutedSignalInput {
  /** Wallet the signal is attributed to. For `face='consumer'` this is the payer
   *  (the agent making the call). For `face='provider'` this is the operator
   *  (the gateway that delivered + broadcast the settlement). */
  walletAddress: string;
  txSignature: string;
  operatorAddress: string;
  /** Required: which face this signal credits. Payer side = consumer (paid
   *  clean). Operator side = provider (delivered the call). */
  face: KarmaFace;
  /** Optional: the payer wallet — recorded in payload so operator-side rollups
   *  can count unique payers without a join across the signal_events table. */
  payerWallet?: string;
  observedAt?: string | Date;
  protocol?: 'x402' | 'mpp' | 'hybrid';
  operatorId?: string;
}

export function buildPayshRoutedSignal(
  input: PayshRoutedSignalInput,
): InsertSignalEventInput {
  const out: InsertSignalEventInput = {
    agentWallet: input.walletAddress,
    tier: 1,
    kind: 'paysh_routed',
    face: input.face,
    weight: 1.0,
    value: 1.0,
    signedBy: input.operatorAddress,
    txRef: input.txSignature,
    payload: {
      operator: input.operatorAddress,
      operatorId: input.operatorId ?? null,
      protocol: input.protocol ?? null,
      payer: input.payerWallet ?? null,
    },
  };
  if (input.observedAt !== undefined) out.observedAt = input.observedAt;
  return out;
}

/**
 * Build the Tier 1 `erc8183_job_settled` signal for one settled Arc job.
 *
 * An ERC-8183 `PaymentReleased` is a max-strength receipt-gated attestation:
 * the escrow contract released funds to the provider only after the job
 * settled, so the settlement itself is a non-repudiable delivery proof. Both
 * faces are emitted: the provider (got paid) and the client (settled clean).
 * `value = 1.0` — like `paysh_routed`, we do not down-weight a settled job by
 * amount the way Tier 2 x402 does.
 *
 * `signed_by` = counterparty (the other face of the settlement). Idempotent:
 * the unique index on (agent_wallet, kind, tx_ref) makes re-emission a no-op so
 * the indexer + backfill can both run. tx_ref = `${jobId}:${txHash}`.
 */
export interface JobSettledSignalInput {
  /** Wallet the signal is attributed to. For `face='provider'` this is the
   *  payee (got paid). For `face='consumer'` this is the client (settled). */
  walletAddress: string;
  /** Which face this signal credits. */
  face: KarmaFace;
  /** ERC-8183 jobId (decimal string). */
  jobId: string;
  /** Settlement (PaymentReleased) tx hash. */
  txHash: string;
  /** Settled amount in human USDC units (6-dec decoded). */
  amount: number;
  /** The other face's wallet (provider for a consumer signal, vice versa). */
  counterparty: string;
  observedAt?: string | Date;
}

export function buildJobSettledSignal(
  input: JobSettledSignalInput,
): InsertSignalEventInput {
  const out: InsertSignalEventInput = {
    agentWallet: input.walletAddress,
    tier: 1,
    kind: 'erc8183_job_settled',
    face: input.face,
    weight: 1.0,
    value: 1.0,
    signedBy: input.counterparty,
    txRef: `${input.jobId}:${input.txHash}`,
    payload: {
      jobId: input.jobId,
      amount: input.amount,
      counterparty: input.counterparty,
    },
  };
  if (input.observedAt !== undefined) out.observedAt = input.observedAt;
  return out;
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
 * Build the Autonomy Confidence signal for a wallet (RFC v0.3 §5.5).
 *
 * Autonomy is orthogonal to Karma — stored as a Tier 2 behavioral signal for
 * provenance, but MUST NOT be blended into the karma score. Scorers read it
 * from its own column / payload and render it in its own chip.
 */
export function buildAutonomySignal(
  walletAddress: string,
  autonomy: AutonomyResult,
): InsertSignalEventInput {
  return {
    agentWallet: walletAddress,
    tier: 2,
    kind: 'autonomy',
    face: 'provider',
    weight: 1.0,
    value: autonomy.score / 100,
    txRef: AGGREGATE_TX_REF,
    payload: {
      score: autonomy.score,
      label: autonomy.label,
      components: autonomy.components,
      effectiveWeights: autonomy.effectiveWeights,
      txCount: autonomy.txCount,
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
