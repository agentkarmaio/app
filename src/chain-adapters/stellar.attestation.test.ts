/// <reference types="bun-types" />
/**
 * Stellar adapter attestation wiring (U3b).
 *
 * Tests the pure resolvers (resolveAttestationScore / resolvePublish) that the
 * adapter methods delegate to. Every test runs against a MOCKED rpc.Server
 * (injected) — no live network, no DB. Inline StrKey fixtures (Keypair.random)
 * so the SDK's checksum validation passes (Correction C5).
 *
 * Run: bun test src/chain-adapters/stellar.attestation.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { resolveAttestationScore, resolvePublish } from './stellar';
import {
  nativeToScVal,
  Keypair,
  Account,
  SorobanDataBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import type { WalletScore } from '@/scoring/index';

const VALIDATOR_KP = Keypair.random();

/** Raw-wire simulate-success: result.retval (reads) + transactionData/results (assemble). */
function simSuccess(retval: xdr.ScVal) {
  return {
    result: { retval },
    transactionData: new SorobanDataBuilder().build().toXDR('base64'),
    minResourceFee: '100',
    results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXDR('base64') }],
    latestLedger: 1,
    events: [],
  };
}

function rpcWithScore(score: number | null) {
  const struct = nativeToScVal(
    score == null
      ? { count: BigInt(0), summary_value: BigInt(0), summary_value_decimals: 0 }
      : { count: BigInt(1), summary_value: BigInt(score), summary_value_decimals: 0 },
    {
      type: {
        count: ['symbol', 'u64'],
        summary_value: ['symbol', 'i128'],
        summary_value_decimals: ['symbol', 'u32'],
      },
    },
  );
  return {
    getAccount: async () => new Account(VALIDATOR_KP.publicKey(), '1'),
    simulateTransaction: async () => simSuccess(struct),
    sendTransaction: async () => ({ status: 'PENDING', hash: 'ADTX' }),
    getTransaction: async () => ({ status: 'SUCCESS' }),
  } as unknown as import('@stellar/stellar-sdk').rpc.Server;
}

const kp = VALIDATOR_KP;
const score = {
  address: 'GTARGET',
  score: 90,
  providerScore: 90,
  consumerScore: 50,
  trustTier: 'Excellent',
  confidenceBadge: 'receipt-backed',
} as unknown as WalletScore;

describe('stellar adapter attestation wiring', () => {
  test('resolveAttestationScore: registered → rounded score', async () => {
    const s = await resolveAttestationScore({
      agentId: 7,
      server: rpcWithScore(90),
      validatorAddress: kp.publicKey(),
    });
    expect(s).toBe(90);
  });

  test('resolveAttestationScore: unregistered → 0', async () => {
    const s = await resolveAttestationScore({
      agentId: null,
      server: rpcWithScore(null),
      validatorAddress: kp.publicKey(),
    });
    expect(s).toBe(0);
  });

  test('resolvePublish: unregistered → skipped no_stellar_agent_id', async () => {
    const r = await resolvePublish({
      score,
      agentId: null,
      validatorAddress: kp.publicKey(),
      mode: 'execute',
      deps: { server: rpcWithScore(null), keypair: kp },
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('no_stellar_agent_id');
    expect(r.address).toBe('GTARGET');
  });

  test('resolvePublish: drift → publishes with txId', async () => {
    const r = await resolvePublish({
      score,
      agentId: 7,
      validatorAddress: kp.publicKey(),
      mode: 'execute',
      deps: { server: rpcWithScore(60) /* |90-60|=30 */, keypair: kp },
    });
    expect(r.skipped).toBe(false);
    expect(r.txId).toBe('ADTX');
  });
});
