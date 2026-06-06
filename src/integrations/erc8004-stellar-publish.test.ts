/// <reference types="bun-types" />
/**
 * Write-path unit tests for the Stellar 8004 client (U3b).
 *
 * Every test runs against a MOCKED rpc.Server (injected) — no live network,
 * no contract calls, no .keys file read. Fixtures build real xdr.ScVal values
 * and inline StrKey (Keypair.random()) so the SDK's checksum validation passes
 * (Correction C5 — no truncated/placeholder IDs).
 *
 * Run: bun test src/integrations/erc8004-stellar-publish.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  Account,
  Keypair,
  nativeToScVal,
  scValToNative,
  Address,
  SorobanDataBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import {
  feedbackHashFromJson,
  buildGiveFeedbackArgs,
  keypairFromSecret,
  validatorAddressFromSecret,
  loadStellarKeypair,
  publishStellarFeedback,
  publishStellarScore,
  DELTA_THRESHOLD,
} from './erc8004-stellar-publish';
import type { WalletScore } from '@/scoring/index';

function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ── feedbackHashFromJson (sha256, NOT keccak256) ─────────────────────────────

describe('feedbackHashFromJson', () => {
  test('produces a 32-byte sha256 (NOT keccak256) of canonical JSON', () => {
    const payload = { wallet: 'GABC', providerScore: 85, tier: 'Excellent' };
    const out = feedbackHashFromJson(payload);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(32);
    expect(toHex(out)).toBe(toHex(sha256(new TextEncoder().encode(JSON.stringify(payload)))));
  });

  test('sha256 differs from keccak256 for the same input (empty string)', () => {
    const out = feedbackHashFromJson('');
    // keccak256('""') would NOT equal sha256('""'); guard against a wrong hash fn.
    expect(toHex(out)).toBe(toHex(sha256(new TextEncoder().encode('""'))));
    expect(toHex(out)).not.toBe('c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  });

  test('deterministic for identical payloads', () => {
    const p = { a: 1, b: 2 };
    expect(toHex(feedbackHashFromJson(p))).toBe(toHex(feedbackHashFromJson(p)));
  });
});

// ── buildGiveFeedbackArgs (exact contract order/types) ───────────────────────

const CALLER = Keypair.random().publicKey();

describe('buildGiveFeedbackArgs', () => {
  test('encodes 9 args in contract order with correct types', () => {
    const hash = new Uint8Array(32).fill(1);
    const args = buildGiveFeedbackArgs({
      caller: CALLER,
      agentId: 7,
      value: BigInt(85),
      valueDecimals: 0,
      tag1: 'provider',
      tag2: 'agentkarma',
      endpoint: '',
      feedbackUri: 'https://agentkarma.io/f/7',
      feedbackHash: hash,
    });
    expect(args).toHaveLength(9);
    expect(scValToNative(args[0])).toBe(CALLER); // caller Address
    expect(scValToNative(args[1])).toBe(7); // agent_id u32
    expect(scValToNative(args[2])).toBe(BigInt(85)); // value i128
    expect(scValToNative(args[3])).toBe(0); // value_decimals u32
    expect(scValToNative(args[4])).toBe('provider');
    expect(scValToNative(args[5])).toBe('agentkarma');
    expect(scValToNative(args[6])).toBe(''); // endpoint
    expect(scValToNative(args[7])).toBe('https://agentkarma.io/f/7'); // feedback_uri
    expect(scValToNative(args[8])).toEqual(hash); // BytesN<32>
  });

  test('rejects a feedbackHash that is not 32 bytes', () => {
    expect(() =>
      buildGiveFeedbackArgs({
        caller: CALLER,
        agentId: 7,
        value: BigInt(85),
        valueDecimals: 0,
        tag1: 'provider',
        tag2: 'agentkarma',
        endpoint: '',
        feedbackUri: '',
        feedbackHash: new Uint8Array(16),
      }),
    ).toThrow(/32 bytes/);
  });

  test('rejects valueDecimals over 18', () => {
    expect(() =>
      buildGiveFeedbackArgs({
        caller: CALLER,
        agentId: 7,
        value: BigInt(85),
        valueDecimals: 19,
        tag1: 'provider',
        tag2: 'agentkarma',
        endpoint: '',
        feedbackUri: '',
        feedbackHash: new Uint8Array(32),
      }),
    ).toThrow(/18/);
  });
});

// ── keypair handling (no silent fallback) ────────────────────────────────────

describe('keypair handling', () => {
  test('derives the same G... address as Keypair.fromSecret', () => {
    const kp = Keypair.random();
    const secret = kp.secret(); // S...
    expect(keypairFromSecret(secret).publicKey()).toBe(kp.publicKey());
    expect(validatorAddressFromSecret(secret)).toBe(kp.publicKey());
  });

  test('rejects a malformed secret (no silent fallback)', () => {
    expect(() => keypairFromSecret('not-a-secret')).toThrow();
  });

  // ── 0600 keyfile permission assertion (reviewer hardening) ─────────────────
  // The keyfile path is the secret seed. Loading it from a file MUST assert the
  // file is 0600 (owner-only), not merely claim it in a comment — a world- or
  // group-readable seed is a leak. env override path is exempt (no file).

  test('loadStellarKeypair throws when the keyfile is not 0600', () => {
    const kp = Keypair.random();
    expect(() =>
      loadStellarKeypair(
        {}, // no STELLAR_PRIVATE_KEY → file path
        {
          readFile: () => JSON.stringify({ secret: kp.secret() }),
          fileMode: () => 0o644, // group/other-readable → must be rejected
        },
      ),
    ).toThrow(/0600|permission|mode/i);
  });

  test('loadStellarKeypair accepts a 0600 keyfile', () => {
    const kp = Keypair.random();
    const loaded = loadStellarKeypair(
      {},
      {
        readFile: () => JSON.stringify({ secret: kp.secret() }),
        fileMode: () => 0o600,
      },
    );
    expect(loaded.publicKey()).toBe(kp.publicKey());
  });

  test('loadStellarKeypair env override skips the file-mode check', () => {
    const kp = Keypair.random();
    const loaded = loadStellarKeypair({ STELLAR_PRIVATE_KEY: kp.secret() });
    expect(loaded.publicKey()).toBe(kp.publicKey());
  });
});

// ── publishStellarFeedback (simulate vs execute) ─────────────────────────────

/**
 * A raw-wire simulate-success response. The execute path runs it through
 * rpc.assembleTransaction, which expects the JSON-RPC wire shape:
 * `transactionData` = base64 XDR string, `results[].xdr` = base64 retval.
 * `result.retval` (parsed ScVal) is what the read path (simulateView) consumes.
 * Adjusting the TEST MOCK to the installed SDK's shape (plan note) — production
 * code is untouched.
 */
function simSuccess(retval: xdr.ScVal) {
  return {
    // read path (simulateView) reads this:
    result: { retval },
    // assembleTransaction (execute path) reads these:
    transactionData: new SorobanDataBuilder().build().toXDR('base64'),
    minResourceFee: '100',
    results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXDR('base64') }],
    latestLedger: 1,
    events: [],
  };
}

function makeFakeRpc(opts: { simError?: string; sendHash?: string } = {}) {
  return {
    getAccount: async () => new Account(CALLER, '12345'),
    simulateTransaction: async () =>
      opts.simError ? { error: opts.simError } : simSuccess(nativeToScVal(null, { type: 'void' })),
    sendTransaction: async () => ({ status: 'PENDING', hash: opts.sendHash ?? 'TXHASH123' }),
    getTransaction: async () => ({ status: 'SUCCESS' }),
  } as unknown as import('@stellar/stellar-sdk').rpc.Server;
}

describe('publishStellarFeedback', () => {
  const kp = Keypair.random();
  const baseInput = {
    agentId: 7,
    value: BigInt(85),
    valueDecimals: 0,
    tag1: 'provider' as const,
    tag2: 'agentkarma',
    endpoint: '',
    feedbackUri: 'https://agentkarma.io/f/7',
    feedbackHash: new Uint8Array(32).fill(2),
  };

  test('simulate mode never sends; returns dryRun', async () => {
    let sent = false;
    const fakeRpc = makeFakeRpc();
    (fakeRpc as unknown as { sendTransaction: () => unknown }).sendTransaction = async () => {
      sent = true;
      return { status: 'PENDING', hash: 'X' };
    };
    const res = await publishStellarFeedback(baseInput, 'simulate', { server: fakeRpc, keypair: kp });
    expect(res.dryRun).toBe(true);
    expect(res.txId).toBeUndefined();
    expect(sent).toBe(false);
  });

  test('execute mode sends and returns txId', async () => {
    const res = await publishStellarFeedback(baseInput, 'execute', {
      server: makeFakeRpc({ sendHash: 'ABC' }),
      keypair: kp,
    });
    expect(res.dryRun).toBe(false);
    expect(res.txId).toBe('ABC');
  });

  test('raises on simulate error (no silent fallback)', async () => {
    await expect(
      publishStellarFeedback(baseInput, 'execute', {
        server: makeFakeRpc({ simError: 'HostError: AgentNotFound' }),
        keypair: kp,
      }),
    ).rejects.toThrow(/AgentNotFound/);
  });
});

// ── publishStellarScore (idempotency + badge-gate) ───────────────────────────

function rpcWithSummary(score: number | null) {
  const struct = nativeToScVal(
    score == null
      ? { count: BigInt(0), summary_value: BigInt(0), summary_value_decimals: 0 }
      : { count: BigInt(2), summary_value: BigInt(score), summary_value_decimals: 0 },
    {
      type: {
        count: ['symbol', 'u64'],
        summary_value: ['symbol', 'i128'],
        summary_value_decimals: ['symbol', 'u32'],
      },
    },
  );
  return {
    getAccount: async () => new Account(CALLER, '1'),
    // Same mock answers both the read (get_summary → result.retval=struct) and
    // the write (give_feedback → transactionData/results for assembleTransaction).
    simulateTransaction: async () => simSuccess(struct),
    sendTransaction: async () => ({ status: 'PENDING', hash: 'IDEMTX' }),
    getTransaction: async () => ({ status: 'SUCCESS' }),
  } as unknown as import('@stellar/stellar-sdk').rpc.Server;
}

describe('publishStellarScore (idempotency)', () => {
  const kp = Keypair.random();
  const score = {
    address: 'GTARGET',
    score: 85,
    providerScore: 85,
    consumerScore: 40,
    trustTier: 'Excellent',
    confidenceBadge: 'receipt-backed',
  } as unknown as WalletScore;

  test('DELTA_THRESHOLD mirrors publish.ts', () => {
    expect(DELTA_THRESHOLD).toBe(3);
  });

  test('unregistered (agentId null) → skipped no_stellar_agent_id (no mint for unclaimed)', async () => {
    const res = await publishStellarScore({
      score,
      agentId: null,
      validatorAddress: kp.publicKey(),
      mode: 'execute',
      deps: { server: rpcWithSummary(null), keypair: kp },
    });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('no_stellar_agent_id');
    expect(res.address).toBe('GTARGET');
  });

  test('on-chain within DELTA_THRESHOLD → skipped delta', async () => {
    const res = await publishStellarScore({
      score,
      agentId: 7,
      validatorAddress: kp.publicKey(),
      mode: 'execute',
      deps: { server: rpcWithSummary(84) /* |85-84|=1<3 */, keypair: kp },
    });
    expect(res.skipped).toBe(true);
    expect(res.reason).toMatch(/delta/);
  });

  test('drift >= threshold → publishes', async () => {
    const res = await publishStellarScore({
      score,
      agentId: 7,
      validatorAddress: kp.publicKey(),
      mode: 'execute',
      deps: { server: rpcWithSummary(70) /* |85-70|=15 */, keypair: kp },
    });
    expect(res.skipped).toBe(false);
    expect(res.txId).toBe('IDEMTX');
  });

  test('no prior on-chain summary (count 0) → publishes', async () => {
    const res = await publishStellarScore({
      score,
      agentId: 7,
      validatorAddress: kp.publicKey(),
      mode: 'execute',
      deps: { server: rpcWithSummary(null), keypair: kp },
    });
    expect(res.skipped).toBe(false);
    expect(res.txId).toBe('IDEMTX');
  });

  // Confirm the caller Address arg is the validator's signing key, not the target.
  test('build args put the validator (caller) as Address arg, target via agentId', () => {
    const args = buildGiveFeedbackArgs({
      caller: kp.publicKey(),
      agentId: 7,
      value: BigInt(85),
      valueDecimals: 0,
      tag1: 'provider',
      tag2: 'agentkarma',
      endpoint: '',
      feedbackUri: '',
      feedbackHash: new Uint8Array(32),
    });
    expect(new Address(scValToNative(args[0]) as string).toString()).toBe(kp.publicKey());
  });
});
