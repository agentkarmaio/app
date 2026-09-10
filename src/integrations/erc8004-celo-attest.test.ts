/// <reference types="bun-types" />
/**
 * Payment-safety tests for the Celo attestation drip.
 *
 * These exist because the Stellar drip taught the lesson the expensive way: a
 * balance floor is not a payment gate, and a dry run that ignores the fee
 * cannot warn that a cadence has become unpublishable. Both gates are pinned
 * here against the costs actually measured on 2026-09-10.
 *
 * Run: bun test src/integrations/erc8004-celo-attest.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { parseEther } from 'viem';
import {
  MAX_FEE_CELO,
  MIN_CELO_BALANCE,
  celoFeeCeilingWei,
  readCeloFeeAccount,
} from './erc8004-celo-attest';
import { ATTEST_MIN_SCORE, feeCeilingError, isFeeCeilingError } from '@/lib/attest-policy';

const SIGNER = '0xf9c63815A7396a45676cD6260856A10df66B2F0d' as const;

/** Cost of one giveFeedback, measured 2026-09-10 at a 202.5 gwei gas price. */
const MEASURED_WRITE_COST = parseEther('0.044453205');
/** The dedicated validator wallet's balance at that same moment. */
const MEASURED_VALIDATOR_BALANCE = parseEther('0.259628249573585528');

describe('celoFeeCeilingWei', () => {
  test('caps at the policy maximum when the balance is healthy', () => {
    expect(celoFeeCeilingWei(parseEther('59.3'))).toBe(parseEther(String(MAX_FEE_CELO)));
    expect(MAX_FEE_CELO).toBe(0.5);
  });

  test('clamps to the balance when that is the binding constraint', () => {
    expect(celoFeeCeilingWei(parseEther('0.1'))).toBe(parseEther('0.1'));
    expect(celoFeeCeilingWei(BigInt(0))).toBe(BigInt(0));
  });

  test('admits a real write and refuses one an order of magnitude out of band', () => {
    const ceiling = celoFeeCeilingWei(parseEther('59.3'));
    expect(MEASURED_WRITE_COST).toBeLessThan(ceiling);
    expect(MEASURED_WRITE_COST * BigInt(20)).toBeGreaterThan(ceiling);
  });

  // Exactness is the point of staying in wei: the Stellar ceiling had to be
  // rewritten because subtracting in decimal units shaved off a stroop.
  test('is exact — no float residue at awkward balances', () => {
    expect(celoFeeCeilingWei(parseEther('1.4'))).toBe(parseEther('0.5'));
    expect(celoFeeCeilingWei(parseEther('0.3'))).toBe(parseEther('0.3'));
  });

  test('an explicit override still cannot exceed the balance', () => {
    expect(celoFeeCeilingWei(parseEther('0.2'), 100)).toBe(parseEther('0.2'));
  });
});

describe('readCeloFeeAccount', () => {
  test('a healthy treasury balance is ok', async () => {
    const r = await readCeloFeeAccount(SIGNER, { getBalance: async () => parseEther('59.3') });
    expect(r.state).toBe('ok');
    expect(r.celo).toBe('59.3');
  });

  // The measured state on 2026-09-10: ~5 writes of runway. A drip armed against
  // this wallet would have started failing mid-run within two days.
  test("the validator's real balance is low — the drip must refuse to start", async () => {
    const r = await readCeloFeeAccount(SIGNER, {
      getBalance: async () => MEASURED_VALIDATOR_BALANCE,
    });
    expect(r.state).toBe('low');
    expect(MIN_CELO_BALANCE).toBe(1);
    // Runway check: the floor must leave more than a couple of writes of warning.
    expect(parseEther(String(MIN_CELO_BALANCE)) / MEASURED_WRITE_COST).toBeGreaterThan(BigInt(10));
  });

  test('an unfunded address reads zero and lands in low, not in an error', async () => {
    const r = await readCeloFeeAccount(SIGNER, { getBalance: async () => BigInt(0) });
    expect(r.state).toBe('low');
    expect(r.wei).toBe(BigInt(0));
  });

  // Not knowing the balance is NOT the same as knowing it is fine.
  test('an RPC failure raises rather than assuming health', async () => {
    await expect(
      readCeloFeeAccount(SIGNER, {
        getBalance: async () => {
          throw new Error('celo rpc 503');
        },
      }),
    ).rejects.toThrow(/503/);
  });
});

describe('shared attest policy', () => {
  test('the publish floor is one value for every chain', () => {
    expect(ATTEST_MIN_SCORE).toBe(70);
  });

  test('fee-ceiling errors are branched on the code, not the message', () => {
    const err = feeCeilingError('too dear', MEASURED_WRITE_COST, BigInt(1));
    expect(isFeeCeilingError(err)).toBe(true);
    expect(err.feeUnits).toBe(MEASURED_WRITE_COST);
    expect(isFeeCeilingError(new Error('fee ceiling exceeded'))).toBe(false);
  });

  test('carries units for both chains — stroops (number) and wei (bigint)', () => {
    expect(isFeeCeilingError(feeCeilingError('x', 538_919_532, 10_000_000))).toBe(true);
    expect(isFeeCeilingError(feeCeilingError('x', parseEther('1'), parseEther('0.5')))).toBe(true);
  });
});
