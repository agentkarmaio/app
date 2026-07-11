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

import type { Transaction, KarmaFace, Chain } from '@/db/schema';
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

// ─── Succession + Bonding signal-event kinds (Dead Man's Switch + bonds) ───────
//
// See docs/BONDING-AND-SUCCESSION-DESIGN.md §4. Typed constants colocated with
// the other signal definitions so callers (indexer, cron, demo seeders) import
// one canonical string and never hand-type a kind.
//
// CARDINAL DISCIPLINE (enforced in scoring/index.ts evidenceGatedTier): these
// signals raise the confidence badge + Tier-presence ONLY. They MUST NOT lift
// the evidence-gated trust-tier ceiling, which stays governed by behavioral
// thickness — a thin-file agent cannot reach "Excellent" on a bond or a will.
//
// `will_declared` is Tier 3 (declared) — it NEVER lifts the badge off ⚪ alone
// without Tier-1/2 corroboration (the badge logic keys off the highest present
// tier, so a wallet whose only signal is `will_declared` stays declared/⚪).
export const SIGNAL_KINDS = {
  // Dead Man's Switch (Agent Wills)
  WILL_DECLARED:        'will_declared',        // T3 provider — declared intent
  HEARTBEAT_OBSERVED:   'heartbeat_observed',   // T2 provider — positive durability
  HEARTBEAT_LAPSED:     'heartbeat_lapsed',     // T2 provider — bounded negative
  INHERITANCE_EXECUTED: 'inheritance_executed', // T1 provider — settled handoff
  WILL_REVOKED:         'will_revoked',         // T1 provider — owner reclaimed
  // Agent Bonding (surety-bond-as-signal)
  BOND_OPENED:          'bond_opened',          // T1 provider — vouch in progress
  BOND_RESOLVED:        'bond_resolved',        // T1 provider — +/- by outcome
} as const;

export type SignalKind = (typeof SIGNAL_KINDS)[keyof typeof SIGNAL_KINDS];

/**
 * Set of signal kinds that lift confidence badge + Tier-presence ONLY and MUST
 * NOT raise the evidence-gated trust-tier ceiling. Read by the scoring layer to
 * enforce the cardinal discipline (a bond/will is "borrowed capital").
 */
export const PRESENCE_ONLY_KINDS: ReadonlySet<string> = new Set<string>([
  SIGNAL_KINDS.WILL_DECLARED,
  SIGNAL_KINDS.INHERITANCE_EXECUTED,
  SIGNAL_KINDS.WILL_REVOKED,
  SIGNAL_KINDS.BOND_OPENED,
  SIGNAL_KINDS.BOND_RESOLVED,
]);

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
 * Build the Tier 1 `usdc_transfer_settled` signal for one plain ERC-20 USDC
 * transfer (no escrow, no evaluator confirmation) — e.g. AgentStack-style
 * Circle Developer-Controlled Wallet nanopayments on Arc. Weaker than
 * `erc8183_job_settled` (weight 0.6 vs 1.0): a bare transfer proves payment
 * happened, not that a job was delivered and confirmed. `chain` is REQUIRED
 * (not optional) — buildJobSettledSignal's omission silently defaulted every
 * Arc signal to chain='solana' and broke the wallets FK; see arc-jobs.ts.
 */
export interface UsdcTransferSignalInput {
  walletAddress: string;
  face: KarmaFace;
  chain: Chain;
  txHash: string;
  amount: number;
  counterparty: string;
  observedAt?: string | Date;
}

export function buildUsdcTransferSignal(
  input: UsdcTransferSignalInput,
): InsertSignalEventInput {
  const out: InsertSignalEventInput = {
    agentWallet: input.walletAddress,
    chain: input.chain,
    tier: 1,
    kind: 'usdc_transfer_settled',
    face: input.face,
    weight: 0.6,
    value: 1.0,
    signedBy: input.counterparty,
    txRef: input.txHash,
    payload: {
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

// ─── Dead Man's Switch signal builders ────────────────────────────────────────

/**
 * Build the Tier 3 `will_declared` signal — an agent declared a succession plan.
 *
 * Declared intent only: durability INTENT, not durability evidence. Tier 3 so
 * the confidence-badge logic NEVER lifts off ⚪ on this alone — heartbeat (T2)
 * or inheritance (T1) corroboration is required for 🟡/🟢. Aggregate tx_ref
 * (one row per wallet, overwrite-idempotent on re-declaration).
 */
export function buildWillDeclaredSignal(
  walletAddress: string,
  opts: { sourceType: string; intervalSeconds: number; willHash?: string | null },
): InsertSignalEventInput {
  return {
    agentWallet: walletAddress,
    tier: 3,
    kind: SIGNAL_KINDS.WILL_DECLARED,
    face: 'provider',
    weight: 1.0,
    value: 0.5, // declared-unverified, mirrors manifest's unverified floor
    txRef: AGGREGATE_TX_REF,
    payload: {
      sourceType: opts.sourceType,
      intervalSeconds: opts.intervalSeconds,
      willHash: opts.willHash ?? null,
    },
  };
}

/**
 * Build the Tier 2 `heartbeat_observed` signal — the agent is alive within its
 * declared succession interval. Positive provider durability. `value` is the
 * recency-decayed liveness strength in [0,1]. Aggregate tx_ref (current state).
 *
 * Succession liveness feeds Provider durability ONLY — never Autonomy. The same
 * raw heartbeat tx is read separately by computeAutonomy for cadence; do not
 * double-count one observation into both orthogonal axes.
 */
export function buildHeartbeatObservedSignal(
  walletAddress: string,
  opts: { strength: number; lastHeartbeatAt: string | Date; intervalSeconds: number },
): InsertSignalEventInput {
  return {
    agentWallet: walletAddress,
    tier: 2,
    kind: SIGNAL_KINDS.HEARTBEAT_OBSERVED,
    face: 'provider',
    weight: 1.0,
    value: clampUnit(opts.strength),
    txRef: AGGREGATE_TX_REF,
    payload: {
      lastHeartbeatAt: toIso(opts.lastHeartbeatAt),
      intervalSeconds: opts.intervalSeconds,
    },
  };
}

/**
 * Build the Tier 2 `heartbeat_lapsed` signal — the declared interval elapsed
 * with no meaningful tx. A BOUNDED negative durability haircut: emitted at
 * Tier 2, so the four-tier weight cap (0.25) structurally prevents zeroing the
 * provider score. `value` carries the (positive) haircut magnitude in [0,1] for
 * display; the scoring layer applies it as a bounded decay, never a Tier-1 hit.
 */
export function buildHeartbeatLapsedSignal(
  walletAddress: string,
  opts: { haircut: number; lapsedAt: string | Date; intervalSeconds: number },
): InsertSignalEventInput {
  return {
    agentWallet: walletAddress,
    tier: 2,
    kind: SIGNAL_KINDS.HEARTBEAT_LAPSED,
    face: 'provider',
    weight: 1.0,
    value: clampUnit(opts.haircut),
    txRef: AGGREGATE_TX_REF,
    payload: {
      lapsedAt: toIso(opts.lapsedAt),
      intervalSeconds: opts.intervalSeconds,
    },
  };
}

/**
 * Build the Tier 1 `inheritance_executed` signal — an on-chain succession
 * transfer settled (graceful handoff). Provider face = the deceased agent's
 * clean handoff. The heir's clean-receipt Consumer-face credit is emitted
 * separately by the caller (two-faced, never collapsed). Per-event tx_ref.
 */
export function buildInheritanceExecutedSignal(
  walletAddress: string,
  opts: { txHash: string; heirCount?: number; observedAt?: string | Date },
): InsertSignalEventInput {
  const out: InsertSignalEventInput = {
    agentWallet: walletAddress,
    tier: 1,
    kind: SIGNAL_KINDS.INHERITANCE_EXECUTED,
    face: 'provider',
    weight: 1.0,
    value: 1.0,
    txRef: opts.txHash,
    payload: { txHash: opts.txHash, heirCount: opts.heirCount ?? null },
  };
  if (opts.observedAt !== undefined) out.observedAt = opts.observedAt;
  return out;
}

/**
 * Build the Tier 1 `will_revoked` signal — the owner reclaimed control before
 * timeout. Neutral/positive: proves liveness + control. Per-event tx_ref.
 */
export function buildWillRevokedSignal(
  walletAddress: string,
  opts: { txHash: string; observedAt?: string | Date },
): InsertSignalEventInput {
  const out: InsertSignalEventInput = {
    agentWallet: walletAddress,
    tier: 1,
    kind: SIGNAL_KINDS.WILL_REVOKED,
    face: 'provider',
    weight: 1.0,
    value: 1.0,
    txRef: opts.txHash,
    payload: { txHash: opts.txHash },
  };
  if (opts.observedAt !== undefined) out.observedAt = opts.observedAt;
  return out;
}

// ─── Agent Bonding signal builders ────────────────────────────────────────────

/**
 * Build the Tier 1 `bond_opened` signal — third parties locked USDC vouching
 * the agent will deliver. Provider face. Strength ramps by underwriter count
 * (1=0.85, 2=0.95, 3+=1.0) × log-scaled bonded amount. tx_ref = `bondId:txHash`
 * for per-event dedup.
 *
 * CARDINAL: this is real money (badge → 🟢) but it raises confidence + presence
 * ONLY. PRESENCE_ONLY_KINDS membership tells the scorer to NOT lift the ceiling.
 */
export function buildBondOpenedSignal(
  walletAddress: string,
  opts: {
    bondId: string;
    txHash: string;
    underwriterCount: number;
    bondedUsdc: number;
    observedAt?: string | Date;
    /**
     * Marks the signal as DEMO-only. Bonds ship demo-only this round (no on-chain
     * escrow deployed). The scoring aggregator EXCLUDES is_demo signals from real
     * scores — signal_events has no is_demo column, so the flag rides in the
     * payload and the aggregator reads it back.
     */
    isDemo?: boolean;
  },
): InsertSignalEventInput {
  const ramp = opts.underwriterCount >= 3 ? 1.0 : opts.underwriterCount === 2 ? 0.95 : 0.85;
  // log10(1+usdc)/log10(1+10_000) saturates a $10k bond to ~1.0; small bonds
  // contribute proportionally less without ever zeroing.
  const amountFactor = clampUnit(Math.log10(1 + Math.max(0, opts.bondedUsdc)) / Math.log10(10_001));
  const out: InsertSignalEventInput = {
    agentWallet: walletAddress,
    tier: 1,
    kind: SIGNAL_KINDS.BOND_OPENED,
    face: 'provider',
    weight: 1.0,
    value: clampUnit(ramp * amountFactor),
    txRef: `${opts.bondId}:${opts.txHash}`,
    payload: {
      bondId: opts.bondId,
      underwriterCount: opts.underwriterCount,
      bondedUsdc: opts.bondedUsdc,
      is_demo: opts.isDemo ?? false,
    },
  };
  if (opts.observedAt !== undefined) out.observedAt = opts.observedAt;
  return out;
}

/**
 * Build the Tier 1 `bond_resolved` signal — the edge escrow resolved at the edge
 * (success authorized by the beneficiary; failure permissionless post-deadline),
 * AK is never the resolution oracle and only records the terminal state.
 * Success = strong positive (value=1.0); failure = cost-gated negative
 * (value=0.0, flagged in payload). Provider face only. tx_ref=`bondId:txHash`.
 */
export function buildBondResolvedSignal(
  walletAddress: string,
  opts: {
    bondId: string;
    txHash: string;
    outcome: 'success' | 'failure';
    bondedUsdc: number;
    observedAt?: string | Date;
    /** See buildBondOpenedSignal — demo-only marker carried in the payload. */
    isDemo?: boolean;
  },
): InsertSignalEventInput {
  const out: InsertSignalEventInput = {
    agentWallet: walletAddress,
    tier: 1,
    kind: SIGNAL_KINDS.BOND_RESOLVED,
    face: 'provider',
    weight: 1.0,
    value: opts.outcome === 'success' ? 1.0 : 0.0,
    txRef: `${opts.bondId}:${opts.txHash}`,
    payload: {
      bondId: opts.bondId,
      outcome: opts.outcome,
      bondedUsdc: opts.bondedUsdc,
      is_demo: opts.isDemo ?? false,
    },
  };
  if (opts.observedAt !== undefined) out.observedAt = opts.observedAt;
  return out;
}

// ─── local helpers ────────────────────────────────────────────────────────────

function clampUnit(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function toIso(v: string | Date): string {
  return typeof v === 'string' ? v : v.toISOString();
}
