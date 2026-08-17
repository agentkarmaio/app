/**
 * Settlement Quality — the receipt-gated, Sybil-discounted delivery axis.
 *
 * Answers "has this agent actually DELIVERED for real, independent counterparties?"
 * On a permissionless ERC-8004/8183 chain, both feedback (ungated `readAllFeedback`)
 * and even settlements can be self-issued — an operator can mint agents, write
 * themselves 5-star reviews, and emit `PaymentReleased` from their own wallet
 * cluster. Raw feedback ratios and raw settlement counts are therefore NOT proof.
 *
 * The only durable signal is a settlement RECEIPT (Tier-1 `erc8183_job_settled`)
 * whose counterparty is DISTINCT and non-Sybil. This module folds an agent's
 * receipts into a count + a `reliable | mixed | unproven` label — never a fabricated
 * percentage.
 *
 * ORTHOGONAL AXIS — like Autonomy and Surety, Settlement Quality is DISPLAYED
 * ALONGSIDE the karma score, never folded into it (where karma IS computed,
 * settlements already feed it as Tier-1 receipts via aggregateSignalEvents; a
 * second blended term would double-count and would re-weight every existing
 * score). See RFC §5.5.
 *
 * On Arc that "where karma is computed" caveat is load-bearing: Arc karma is
 * deliberately NOT persisted (decision 2026-08-17 — the full reasoning lives in
 * the EVM-snapshot header of lib/karma-resolver.ts). So on Arc today this axis
 * is not a companion to a karma score, it is the ONLY reading of delivery — and
 * it works precisely because it reads receipts straight from `signal_events`
 * and needs no rescore pass.
 *
 * Heuristics are deliberately the SAME as the shipped machinery so the whole
 * product speaks one anti-Sybil language:
 *   - min-sample gate mirrors surety's SURETY_MIN_SETTLED_FOR_RELIABLE (=3)
 *   - the funnel test mirrors index.ts's SYBIL_FUNNEL_AVG_TX (=20) /
 *     SYBIL_FUNNEL_MIN_COUNTERPARTIES (=3) inline loyalty cap.
 */

import type { KarmaFace } from '@/db/schema';

export type SettlementLabel = 'reliable' | 'mixed' | 'unproven';

/** Minimum receipts before an agent can read above "unproven". Mirrors surety. */
export const SETTLEMENT_MIN_FOR_PROVEN = 3;
/** Distinct counterparties required for "reliable" (breadth, not just volume). */
export const SETTLEMENT_MIN_DISTINCT_FOR_RELIABLE = 3;
/** Avg receipts/counterparty at/above which a thin spread reads as a wash funnel.
 *  Mirrors index.ts SYBIL_FUNNEL_AVG_TX so both axes flag the same pattern. */
export const SETTLEMENT_SYBIL_FUNNEL_AVG = 20;
/** Below this many distinct counterparties, high volume is treated as a funnel.
 *  Mirrors index.ts SYBIL_FUNNEL_MIN_COUNTERPARTIES. */
export const SETTLEMENT_SYBIL_FUNNEL_MIN_CP = 3;

/** ERC-8183 settlement-receipt signal kind (see buildJobSettledSignal). */
export const ERC8183_SETTLED_KIND = 'erc8183_job_settled';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** One settlement receipt, projected from an `erc8183_job_settled` signal event. */
export interface SettlementReceipt {
  /** The other party: payer (provider face) or payee (consumer face). */
  counterparty: string;
  /** Settled amount (human USDC). Reserved for future volume weighting. */
  amount?: number;
  /**
   * True when the counterparty's on-chain identity matches the documented
   * bulk-mint template shape (see identity-fingerprint.ts). Still counts
   * toward `settledCount` (the job really settled) but NEVER toward
   * `distinctCounterparties` — a templated identity proves nothing about
   * independent delivery.
   */
  templated?: boolean;
}

export interface SettlementQualityResult {
  label: SettlementLabel;
  /** Confidence badge for display: 🟢 reliable / 🟡 mixed / ⚪ unproven. */
  badge: '🟢' | '🟡' | '⚪';
  /** Total receipt-gated settlements. */
  settledCount: number;
  /** Distinct, identifiable (non-empty, non-zero) counterparties. */
  distinctCounterparties: number;
  /** True when receipts funnel through too few counterparties at high volume. */
  sybilFunnel: boolean;
}

function badgeFor(label: SettlementLabel): SettlementQualityResult['badge'] {
  if (label === 'reliable') return '🟢';
  if (label === 'mixed') return '🟡';
  return '⚪';
}

function labelFor(settledCount: number, distinct: number, sybilFunnel: boolean): SettlementLabel {
  // A wash funnel is never proof, regardless of volume.
  if (sybilFunnel) return 'unproven';
  // Too few receipts, or none attributable to an identifiable counterparty.
  if (settledCount < SETTLEMENT_MIN_FOR_PROVEN || distinct === 0) return 'unproven';
  // Enough receipts AND enough independent counterparties → proven delivery.
  if (distinct >= SETTLEMENT_MIN_DISTINCT_FOR_RELIABLE) return 'reliable';
  // Enough receipts but thin counterparty breadth (1–2 distinct).
  return 'mixed';
}

/**
 * Fold an agent's settlement receipts into a quality label. Returns null when the
 * agent has NO receipts — callers should render no axis (not a zero), exactly as
 * computeSurety does for a wallet that has underwritten nothing.
 */
export function computeSettlementQuality(receipts: SettlementReceipt[]): SettlementQualityResult | null {
  if (receipts.length === 0) return null;

  const settledCount = receipts.length;
  const distinct = new Set(
    receipts
      .filter((r) => !r.templated)
      .map((r) => r.counterparty.trim().toLowerCase())
      .filter((cp) => cp.length > 0 && cp !== ZERO_ADDRESS),
  );
  const distinctCounterparties = distinct.size;

  // Guard div-by-zero: with no identifiable counterparty the "avg per cp" is the
  // whole volume (all receipts collapse onto the unknown party).
  const avgPerCounterparty =
    distinctCounterparties > 0 ? settledCount / distinctCounterparties : settledCount;
  const sybilFunnel =
    avgPerCounterparty >= SETTLEMENT_SYBIL_FUNNEL_AVG &&
    distinctCounterparties < SETTLEMENT_SYBIL_FUNNEL_MIN_CP;

  const label = labelFor(settledCount, distinctCounterparties, sybilFunnel);
  return { label, badge: badgeFor(label), settledCount, distinctCounterparties, sybilFunnel };
}

/**
 * Adapter: project `erc8183_job_settled` signal events for one face into receipts.
 * Kept separate from the pure scorer so the scorer stays DB-agnostic + unit-testable.
 * Accepts any row exposing the four fields (a full SignalEvent, or a test literal).
 */
export function settlementReceiptsFromSignals(
  events: ReadonlyArray<{
    kind: string;
    face: string;
    signed_by?: string | null;
    payload?: unknown;
  }>,
  face: KarmaFace,
): SettlementReceipt[] {
  const out: SettlementReceipt[] = [];
  for (const e of events) {
    if (e.kind !== ERC8183_SETTLED_KIND || e.face !== face) continue;
    const payload = (e.payload ?? {}) as {
      counterparty?: unknown; amount?: unknown; templatedCounterparty?: unknown;
    };
    const counterparty =
      e.signed_by ?? (typeof payload.counterparty === 'string' ? payload.counterparty : '') ?? '';
    out.push({
      counterparty: counterparty || '',
      amount: typeof payload.amount === 'number' ? payload.amount : undefined,
      templated: payload.templatedCounterparty === true,
    });
  }
  return out;
}
