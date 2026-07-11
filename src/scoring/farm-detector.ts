/**
 * Farm-detector — pure ratio evaluation against fixed thresholds.
 *
 * See docs/superpowers/specs/2026-07-11-arc-farm-detector-design.md. Replaces
 * the manual, ad-hoc investigation that produced the `project_arc_registry_synthetic`
 * memory (2026-07-03/07-08) with a repeatable, testable judgment: given three
 * bounded samples (bulk-mint tokenURI ratio, settlement self-dealt/templated
 * ratio, feedback positivity ratio), does the data look farmed?
 *
 * Pure + synchronous: the RPC/DB sampling that produces `FarmSamples` lives in
 * scripts/arc-farm-detector.ts. This module only judges pre-computed counts.
 */

export interface FarmSamples {
  /** Recent agentIds near the registry tip, checked via isTemplatedIdentity. */
  bulkMintSample: { total: number; templated: number };
  /** Recent settled ERC-8183 jobs (a window of JobCreated+PaymentReleased). */
  settlementSample: { total: number; selfDealt: number; templated: number };
  /** Sampled agents' feedback: how many show 100%-positive (the farm signature). */
  feedbackSample: { total: number; allPositive: number };
}

export interface FarmReport {
  bulkMintRatio: number;
  selfDealtRatio: number;
  templatedSettlementRatio: number;
  allPositiveFeedbackRatio: number;
  flagged: boolean;
  reasons: string[];
}

/** Ratios at/above these read as "looks farmed" for that sample. */
const BULK_MINT_THRESHOLD = 0.3;
const SELF_DEALT_THRESHOLD = 0.5;
const TEMPLATED_SETTLEMENT_THRESHOLD = 0.3;
const ALL_POSITIVE_FEEDBACK_THRESHOLD = 0.7;
/** Below this many feedback-bearing agents, a 100%-positive ratio proves nothing. */
const FEEDBACK_MIN_SAMPLE = 5;

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

export function evaluateFarmSignals(samples: FarmSamples): FarmReport {
  const bulkMintRatio = ratio(samples.bulkMintSample.templated, samples.bulkMintSample.total);
  const selfDealtRatio = ratio(samples.settlementSample.selfDealt, samples.settlementSample.total);
  const nonSelfDealt = samples.settlementSample.total - samples.settlementSample.selfDealt;
  const templatedSettlementRatio = ratio(samples.settlementSample.templated, nonSelfDealt);
  const allPositiveFeedbackRatio = ratio(samples.feedbackSample.allPositive, samples.feedbackSample.total);

  const reasons: string[] = [];
  if (bulkMintRatio >= BULK_MINT_THRESHOLD) {
    reasons.push(`bulk-mint templated-identity ratio ${(bulkMintRatio * 100).toFixed(0)}% (of ${samples.bulkMintSample.total} sampled)`);
  }
  if (selfDealtRatio >= SELF_DEALT_THRESHOLD) {
    reasons.push(`self-dealt settlement ratio ${(selfDealtRatio * 100).toFixed(0)}% (of ${samples.settlementSample.total} settled)`);
  }
  if (templatedSettlementRatio >= TEMPLATED_SETTLEMENT_THRESHOLD) {
    reasons.push(`templated counterparty ratio ${(templatedSettlementRatio * 100).toFixed(0)}% among non-self-dealt settlements`);
  }
  if (
    samples.feedbackSample.total >= FEEDBACK_MIN_SAMPLE &&
    allPositiveFeedbackRatio >= ALL_POSITIVE_FEEDBACK_THRESHOLD
  ) {
    reasons.push(`100%-positive feedback ratio ${(allPositiveFeedbackRatio * 100).toFixed(0)}% (of ${samples.feedbackSample.total} sampled)`);
  }

  return {
    bulkMintRatio, selfDealtRatio, templatedSettlementRatio, allPositiveFeedbackRatio,
    flagged: reasons.length > 0,
    reasons,
  };
}
