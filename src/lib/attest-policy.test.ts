/// <reference types="bun-types" />
/**
 * Attestation batch policy — pure helpers.
 *
 * Run: bun test src/lib/attest-policy.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { attestRunVerdict, feeCeilingError, isFeeCeilingError } from './attest-policy';

describe('isFeeCeilingError', () => {
  test('recognises the tagged error and nothing else', () => {
    expect(isFeeCeilingError(feeCeilingError('too dear', 538_920_000, 10_000_000))).toBe(true);
    expect(isFeeCeilingError(new Error('fee ceiling exceeded'))).toBe(false);
    expect(isFeeCeilingError(null)).toBe(false);
  });
});

/**
 * 2026-09-13: stellar-attest paged daily because Soroban's give_feedback
 * assembled at 53.89 XLM against a 1 XLM ceiling. The gate refused before
 * signing — nothing was sent, so there is nothing to reconcile. A persistent
 * external price is not a pipeline fault and must not wake anyone nightly.
 */
describe('attestRunVerdict', () => {
  test('a clean run is ok', () => {
    expect(attestRunVerdict({ failed: 0, blocked: 0 })).toBe('ok');
  });

  test('refused-before-signing is blocked, not failed', () => {
    expect(attestRunVerdict({ failed: 0, blocked: 3 })).toBe('blocked');
  });

  test('a write that did not confirm still fails', () => {
    expect(attestRunVerdict({ failed: 1, blocked: 0 })).toBe('failed');
  });

  test('a real failure outranks a blocked one', () => {
    // A run can refuse some targets on fee AND lose one mid-flight; the
    // unconfirmed write is what needs a human, so it wins.
    expect(attestRunVerdict({ failed: 1, blocked: 5 })).toBe('failed');
  });
});
