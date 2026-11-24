/// <reference types="bun-types" />
/**
 * gatherScoreInputs + scoreFromInputs — the single score assembly every
 * surface (API, profile, badge, rescore, publish) goes through.
 *
 * Run: bun test src/scoring/wallet-score.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { Transaction } from '@/db/schema';
import { calculateScore } from './index';
import {
  gatherScoreInputs,
  scoreFromInputs,
  SCORE_TX_WINDOW,
  type ScoreInputDeps,
} from './wallet-score';

const DAY = 24 * 60 * 60 * 1000;
const AS_OF = new Date('2026-06-01T00:00:00.000Z');

function tx(i: number): Transaction {
  return {
    wallet_address: 'W',
    facilitator: 'FAC',
    counterparty: `P${i % 4}`,
    amount: '3',
    timestamp: new Date(AS_OF.getTime() - i * 5 * DAY).toISOString(),
    success: i % 7 !== 0,
    tx_signature: `sig-${i}`,
  } as unknown as Transaction;
}
const TXS = Array.from({ length: 12 }, (_, i) => tx(i + 1));

function deps(over: Partial<ScoreInputDeps> = {}): ScoreInputDeps & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const rec = <A extends unknown[], R>(name: string, fn: (...a: A) => R) => (...a: A): R => {
    calls[name] = a;
    return fn(...a);
  };
  return {
    calls,
    getTransactions: rec('getTransactions', async () => TXS),
    readAttestation: rec('readAttestation', async () => ({ score: 0.8, unavailable: false })),
    getFeedbackSummary: rec('getFeedbackSummary', async () => ({ total: 5, delivered: 4, failed: 1, deliveryRate: 0.8 })),
    getManifestValue: rec('getManifestValue', async () => 0.6),
    getSignalEvents: rec('getSignalEvents', async () => []),
    getAgentBond: rec('getAgentBond', async () => null),
    ...over,
  };
}

describe('gatherScoreInputs', () => {
  test('reads every input once, with the shared window, for the given chain', async () => {
    const d = deps();
    const inputs = await gatherScoreInputs('W', 'solana', { asOf: AS_OF }, d);
    expect(d.calls.getTransactions).toEqual(['W', SCORE_TX_WINDOW, 'solana']);
    expect(d.calls.getFeedbackSummary).toEqual(['W', 'solana']);
    expect(d.calls.getAgentBond).toEqual(['W', 'solana', AS_OF.getTime()]);
    expect(inputs.attestation).toBe(0.8);
    expect(inputs.feedback.total).toBe(5);
    expect(inputs.manifestValue).toBe(0.6);
    expect(inputs.degraded).toEqual([]);
  });

  test('non-Solana chains never read or use an attestation', async () => {
    const d = deps();
    const inputs = await gatherScoreInputs('W', 'celo', { asOf: AS_OF }, d);
    expect(d.calls.readAttestation).toBeUndefined();
    expect(inputs.attestation).toBe(0);
    expect(inputs.degraded).toEqual([]);
  });

  test('a supplied batch attestation is used instead of a per-wallet read', async () => {
    const d = deps();
    const inputs = await gatherScoreInputs('W', 'solana', { attestation: { score: 0.3, unavailable: false } }, d);
    expect(d.calls.readAttestation).toBeUndefined();
    expect(inputs.attestation).toBe(0.3);
  });

  test('an unreadable attestation is reported as degraded, not as zero-and-clean', async () => {
    const inputs = await gatherScoreInputs('W', 'solana', {}, deps({
      readAttestation: async () => ({ score: 0, unavailable: true }),
    }));
    expect(inputs.degraded).toEqual(['attestation']);
  });

  test('failed soft reads degrade to absent and are named', async () => {
    const boom = async () => { throw new Error('db down'); };
    const inputs = await gatherScoreInputs('W', 'solana', {}, deps({
      getFeedbackSummary: boom, getSignalEvents: boom,
    }));
    expect(inputs.feedback.total).toBe(0);
    expect(inputs.signalEvents).toEqual([]);
    expect(inputs.degraded.sort()).toEqual(['feedback', 'signalEvents']);
  });

  test('a failed Agent Bond read throws — a missing slash penalty would inflate the score', async () => {
    await expect(gatherScoreInputs('W', 'stellar-testnet', {}, deps({
      getAgentBond: async () => { throw new Error('bond rpc down'); },
    }))).rejects.toThrow('bond rpc down');
  });

  test('a failed transaction read throws — there is no score without it', async () => {
    await expect(gatherScoreInputs('W', 'solana', {}, deps({
      getTransactions: async () => { throw new Error('db down'); },
    }))).rejects.toThrow('db down');
  });
});

describe('scoreFromInputs', () => {
  test('passes every gathered input to calculateScore (feedback included)', async () => {
    const inputs = await gatherScoreInputs('W', 'solana', { asOf: AS_OF }, deps());
    const got = scoreFromInputs(inputs, { asOf: AS_OF });
    const want = calculateScore(
      TXS, 0.8, 0.8, 5, inputs.cadence?.automationScore ?? null, 0.6, null, [], null, { asOf: AS_OF },
    );
    expect(got).toEqual(want);
    // Feedback moved the Tier-1 aggregate — it is not silently dropped.
    const noFeedback = calculateScore(TXS, 0.8, undefined, undefined, inputs.cadence?.automationScore ?? null, 0.6, null, [], null, { asOf: AS_OF });
    expect(got!.tierAggregates.tier1).not.toBe(noFeedback.tierAggregates.tier1);
  });

  test('is deterministic for a fixed asOf', async () => {
    const inputs = await gatherScoreInputs('W', 'solana', { asOf: AS_OF }, deps());
    expect(scoreFromInputs(inputs, { asOf: AS_OF })).toEqual(scoreFromInputs(inputs, { asOf: AS_OF }));
  });

  test('null when there are no transactions', async () => {
    const inputs = await gatherScoreInputs('W', 'solana', {}, deps({ getTransactions: async () => [] }));
    expect(scoreFromInputs(inputs)).toBeNull();
    expect(inputs.cadence).toBeNull();
    expect(inputs.autonomy).toBeNull();
  });
});
