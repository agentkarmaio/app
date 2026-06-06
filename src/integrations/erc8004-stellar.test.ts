/// <reference types="bun-types" />
/**
 * Read-path unit tests for the Stellar 8004 client (U3a).
 *
 * Every test runs against a MOCKED rpc.Server (injected) — no live network,
 * no contract calls. Fixtures build real xdr.ScVal values so `scValToNative`
 * decodes them exactly as the live simulateTransaction path would.
 *
 * Run: bun test src/integrations/erc8004-stellar.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { Account, Address, Keypair, nativeToScVal, scValToNative, xdr, rpc } from '@stellar/stellar-sdk';
import {
  decodeSummary,
  simulateView,
  makeStellarRpc,
  buildSummaryArgs,
  readStellarSummary,
  readStellarAgentWallet,
  computeAttestationScore,
  AK_TAG2,
  type FeedbackSummary,
} from './erc8004-stellar';
import {
  STELLAR_REPUTATION_REGISTRY,
  STELLAR_IDENTITY_REGISTRY,
} from './stellar-config';

// Real StrKey fixtures generated inline (Correction C5 — no truncated/invalid
// IDs; the SDK's Address/Account constructors validate the StrKey checksum).
const VIEW_ACCOUNT = Keypair.random().publicKey();
const VALIDATOR = Keypair.random().publicKey();

/** A SummaryResult struct as scValToNative would yield from get_summary. */
function summaryScVal(count: number, value: number, decimals: number): xdr.ScVal {
  return nativeToScVal(
    { count: BigInt(count), summary_value: BigInt(value), summary_value_decimals: decimals },
    {
      type: {
        count: ['symbol', 'u64'],
        summary_value: ['symbol', 'i128'],
        summary_value_decimals: ['symbol', 'u32'],
      },
    },
  );
}

/** Minimal fake rpc.Server returning a fixed retval (success path). */
function fakeRpc(retval: xdr.ScVal): rpc.Server {
  return {
    getAccount: async () => new Account(VIEW_ACCOUNT, '0'),
    simulateTransaction: async () => ({ result: { retval } }),
  } as unknown as rpc.Server;
}

/** Fake rpc.Server returning a simulate ERROR (no result). */
function errorRpc(message: string): rpc.Server {
  return {
    getAccount: async () => new Account(VIEW_ACCOUNT, '0'),
    simulateTransaction: async () => ({ error: message }),
  } as unknown as rpc.Server;
}

describe('decodeSummary', () => {
  test('normalizes summary_value by summary_value_decimals', () => {
    const s: FeedbackSummary = decodeSummary({ count: BigInt(3), summary_value: BigInt(85), summary_value_decimals: 0 });
    expect(s.count).toBe(3);
    expect(s.summaryValue).toBe(85);
    expect(s.rawSummaryValue).toBe(BigInt(85));
    expect(s.summaryValueDecimals).toBe(0);
  });

  test('decimals>0 divides correctly (8500 @ 2 → 85.00)', () => {
    const s = decodeSummary({ count: BigInt(1), summary_value: BigInt(8500), summary_value_decimals: 2 });
    expect(s.summaryValue).toBe(85);
  });

  test('zero count → summaryValue 0', () => {
    const s = decodeSummary({ count: BigInt(0), summary_value: BigInt(0), summary_value_decimals: 0 });
    expect(s.count).toBe(0);
    expect(s.summaryValue).toBe(0);
  });
});

describe('makeStellarRpc', () => {
  test('returns an rpc.Server instance pointed at the resolved URL', () => {
    const server = makeStellarRpc();
    expect(server).toBeInstanceOf(rpc.Server);
  });
});

describe('simulateView', () => {
  test('decodes a u64 retval through scValToNative', async () => {
    const retval = nativeToScVal(BigInt(7), { type: 'u64' });
    const out = await simulateView(fakeRpc(retval), {
      contractId: STELLAR_REPUTATION_REGISTRY,
      method: 'get_last_index',
      args: [],
      sourceAccount: VIEW_ACCOUNT,
    });
    expect(out).toBe(BigInt(7));
  });

  test('throws on simulate error response (no silent fallback)', async () => {
    await expect(
      simulateView(errorRpc('HostError: agent not found'), {
        contractId: STELLAR_REPUTATION_REGISTRY,
        method: 'get_last_index',
        args: [],
        sourceAccount: VIEW_ACCOUNT,
      }),
    ).rejects.toThrow(/agent not found/);
  });

  test('throws when simulate returns neither result nor error', async () => {
    const emptyRpc = {
      getAccount: async () => new Account(VIEW_ACCOUNT, '0'),
      simulateTransaction: async () => ({}),
    } as unknown as rpc.Server;
    await expect(
      simulateView(emptyRpc, {
        contractId: STELLAR_REPUTATION_REGISTRY,
        method: 'get_summary',
        args: [],
      }),
    ).rejects.toThrow(/no result/i);
  });
});

describe('buildSummaryArgs', () => {
  test('encodes agentId u32, single client, tags', () => {
    const args = buildSummaryArgs(42, [VALIDATOR], 'provider', 'agentkarma');
    expect(args).toHaveLength(4);
    expect(scValToNative(args[0])).toBe(42); // u32 agentId
    expect(scValToNative(args[2])).toBe('provider'); // tag1
    expect(scValToNative(args[3])).toBe('agentkarma'); // tag2
  });

  test('rejects empty client list (contract would revert)', () => {
    expect(() => buildSummaryArgs(42, [], 'provider', 'agentkarma')).toThrow(/client/i);
  });

  test('caps client list at the contract maximum of 5', () => {
    const many = Array.from({ length: 8 }, () => Address.fromString(VALIDATOR).toString());
    const args = buildSummaryArgs(1, many, 'provider', 'agentkarma');
    const clients = scValToNative(args[1]) as unknown[];
    expect(clients.length).toBe(5);
  });
});

describe('readStellarSummary', () => {
  test('decodes get_summary struct via injected rpc', async () => {
    const summary = await readStellarSummary(
      fakeRpc(summaryScVal(3, 85, 0)),
      3,
      [VALIDATOR],
      'provider',
      'agentkarma',
    );
    expect(summary.count).toBe(3);
    expect(summary.summaryValue).toBe(85);
  });

  test('propagates the simulate error (e.g. empty-client revert from chain)', async () => {
    await expect(
      readStellarSummary(errorRpc('ClientAddressesRequired'), 3, [VALIDATOR], 'provider', 'agentkarma'),
    ).rejects.toThrow(/ClientAddressesRequired/);
  });
});

describe('readStellarAgentWallet', () => {
  test('resolves the bound agentWallet StrKey for a registered agentId', async () => {
    const walletScVal = new Address(VALIDATOR).toScVal();
    const wallet = await readStellarAgentWallet(fakeRpc(walletScVal), 7);
    expect(wallet).toBe(VALIDATOR);
  });

  test('returns null when the agent has no bound wallet (void/None)', async () => {
    const noneScVal = xdr.ScVal.scvVoid();
    const wallet = await readStellarAgentWallet(fakeRpc(noneScVal), 99);
    expect(wallet).toBeNull();
  });
});

describe('computeAttestationScore', () => {
  test('unregistered wallet (null agentId) → 0 (badge-gated, no rpc call)', async () => {
    let called = 0;
    const watchRpc = {
      getAccount: async () => { called++; return new Account(VIEW_ACCOUNT, '0'); },
      simulateTransaction: async () => { called++; return { result: { retval: summaryScVal(1, 1, 0) } }; },
    } as unknown as rpc.Server;
    const score = await computeAttestationScore({
      agentId: null,
      server: watchRpc,
      validatorAddress: VALIDATOR,
    });
    expect(score).toBe(0);
    expect(called).toBe(0);
  });

  test('registered wallet → rounded summary score', async () => {
    const score = await computeAttestationScore({
      agentId: 7,
      server: fakeRpc(summaryScVal(2, 87, 0)),
      validatorAddress: VALIDATOR,
    });
    expect(score).toBe(87);
  });

  test('zero feedback count → 0 even when agentId is set', async () => {
    const score = await computeAttestationScore({
      agentId: 7,
      server: fakeRpc(summaryScVal(0, 0, 0)),
      validatorAddress: VALIDATOR,
    });
    expect(score).toBe(0);
  });

  test('rounds a fractional WAD summary (8650 @ 2 → 87)', async () => {
    const score = await computeAttestationScore({
      agentId: 7,
      server: fakeRpc(summaryScVal(4, 8650, 2)),
      validatorAddress: VALIDATOR,
      tag1: 'consumer',
    });
    expect(score).toBe(87); // 86.5 rounds to 87
  });

  test('AK_TAG2 is the agentkarma namespace tag', () => {
    expect(AK_TAG2).toBe('agentkarma');
  });

  test('exercises the contract IDs it reads against', () => {
    // Guard against an accidental ID swap in config — the read path binds to
    // the pinned reputation + identity registries.
    expect(STELLAR_REPUTATION_REGISTRY).toMatch(/^C[A-Z2-7]{55}$/);
    expect(STELLAR_IDENTITY_REGISTRY).toMatch(/^C[A-Z2-7]{55}$/);
  });
});
