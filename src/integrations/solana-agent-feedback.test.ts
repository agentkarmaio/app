/// <reference types="bun-types" />
/**
 * Solana 8004 feedback lives on the agent's Core ASSET, not on its wallet.
 * Reproduces two defects:
 *   - publish wrote `karma_score` with the WALLET as the asset (never landed:
 *     the 8004 indexer holds 0 `karma_score` records on Solana mainnet);
 *   - the Tier-1 read used getSummary(wallet).averageScore, which is an ATOM
 *     quality stat, not a score average, and would include AK's own published
 *     score — AK reading itself back as receipt-grade evidence.
 *
 * Run: bun test src/integrations/solana-agent-feedback.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { thirdPartyFeedbackScore, ownPublishedScore, type AgentFeedback } from './solana-agent-feedback';

const AK = 'AKPUBLISHER';
const fb = (over: Partial<AgentFeedback>): AgentFeedback => ({
  client: 'THIRDPARTY', tag1: 'reachable', score: 100, revoked: false, feedbackIndex: 0n, ...over,
});

describe('thirdPartyFeedbackScore', () => {
  test('averages third-party scores, normalized to 0–1', () => {
    expect(thirdPartyFeedbackScore([fb({ score: 100 }), fb({ score: 100 }), fb({ score: 0 })], AK)).toBeCloseTo(2 / 3);
  });

  test("never counts AK's own records, nor anyone's karma_score look-alikes", () => {
    expect(thirdPartyFeedbackScore([fb({ client: AK, tag1: 'karma_score', score: 95 }), fb({ score: 40 })], AK)).toBeCloseTo(0.4);
    expect(thirdPartyFeedbackScore([fb({ client: AK, tag1: 'trust', score: 95 })], AK)).toBe(0);
    expect(thirdPartyFeedbackScore([fb({ tag1: 'karma_score', score: 95 })], AK)).toBe(0);
  });

  test('ignores revoked and unscored records', () => {
    expect(thirdPartyFeedbackScore([fb({ revoked: true, score: 100 }), fb({ score: null }), fb({ score: 50 })], AK)).toBeCloseTo(0.5);
  });

  test('no feedback → 0 (absent)', () => {
    expect(thirdPartyFeedbackScore([], AK)).toBe(0);
  });
});

describe('ownPublishedScore', () => {
  test("is AK's latest karma_score on the asset", () => {
    expect(ownPublishedScore([
      fb({ client: AK, tag1: 'karma_score', score: 70, feedbackIndex: 1n }),
      fb({ client: AK, tag1: 'karma_score', score: 82, feedbackIndex: 3n }),
      fb({ client: AK, tag1: 'karma_score', score: 75, feedbackIndex: 2n }),
      fb({ score: 10, feedbackIndex: 9n }),
    ], AK)).toBe(82);
  });

  test('a karma_score written by anyone else is not mistaken for AK (drift-check spoof)', () => {
    expect(ownPublishedScore([fb({ client: 'IMPOSTOR', tag1: 'karma_score', score: 99, feedbackIndex: 7n })], AK)).toBeNull();
  });

  test('null when AK never published here, or AK has no publisher key', () => {
    expect(ownPublishedScore([fb({ score: 10 })], AK)).toBeNull();
    expect(ownPublishedScore([fb({ client: AK, tag1: 'karma_score', score: 80 })], null)).toBeNull();
  });
});
