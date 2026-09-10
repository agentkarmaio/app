/**
 * ERC-8004 Stellar write path — AgentKarma as a 8004 validator on the
 * trionlabs/stellar-8004 LIVE Reputation Registry (mainnet). D1 (spec §2).
 *
 * Mirrors `erc8004-celo-publish.ts`:
 *  - AK's own Stellar wallet is a registered agent (self-feedback blocked), so
 *    AK MUST target a different agentId. Mint AK's validator agentId once via
 *    register-stellar-validator.ts (mirrors Celo agentId 9058).
 *  - Caller passes a target agentId that EXISTS (resolve via persisted
 *    stellar_agent_id / readStellarAgentWallet first; give_feedback reverts
 *    with AgentNotFound otherwise). publishStellarScore badge-gates: a wallet
 *    with no stellar_agent_id is SKIPPED, never minted (mirrors Celo).
 *  - Two-faced karma → two entries (tag1='provider' | 'consumer'); tag2 scopes
 *    AK's records ('agentkarma').
 *  - Integrity hash is sha256 (Soroban host fn), NOT keccak256 (risk #3).
 *
 * give_feedback sig verified 2026-06-06 against reputation-registry/src/contract.rs:
 *   give_feedback(caller, agent_id:u32, value:i128, value_decimals:u32,
 *                 tag1:String, tag2:String, endpoint:String,
 *                 feedback_uri:String, feedback_hash:BytesN<32>)
 *
 * Env: STELLAR_RPC_URL (optional override; resolveStellarRpcUrl falls back to
 * the mainnet Soroban RPC default). STELLAR_PRIVATE_KEY (secret seed S...) or
 * .keys/agentkarma-stellar.json { "secret": "S..." } (0600, gitignored).
 */
import {
  rpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  Address,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
// @noble/hashes@2.x exposes sha256 under the `sha2` entrypoint (no `sha256`
// subpath, no extensionless `sha2`). Verified against the installed v2.0.1.
import { sha256 } from '@noble/hashes/sha2.js';
import { readFileSync, statSync } from 'fs';
import { resolve } from 'path';
import type { PublishResult } from '@/chain-adapters/types';
import type { WalletScore } from '@/scoring/index';
import {
  STELLAR_REPUTATION_REGISTRY,
  STELLAR_NETWORK_PASSPHRASE,
  resolveStellarRpcUrl,
} from './stellar-config';
import { readStellarSummary, AK_TAG2 } from './erc8004-stellar';
import { AK_STELLAR } from '@/config/ak-validator';

// ─── Feedback integrity hash (sha256, NOT keccak256) ─────────────────────────

/**
 * Deterministic sha256 over an off-chain feedback payload. Returns the raw
 * 32-byte digest for a BytesN<32> contract arg. Soroban has no keccak256 — the
 * host function is sha256, so the Celo keccak256 precedent does NOT carry over.
 */
export function feedbackHashFromJson(payload: unknown): Uint8Array {
  const canonical = JSON.stringify(payload);
  return sha256(new TextEncoder().encode(canonical));
}

// ─── give_feedback argument encoding ─────────────────────────────────────────

export interface GiveFeedbackArgs {
  /** AK validator G... — the signing caller, NOT the rated agent. */
  caller: string;
  agentId: number; // u32 — the rated agent
  value: bigint; // i128
  valueDecimals: number; // u32, ≤18
  tag1: string; // 'provider' | 'consumer'
  tag2: string; // 'agentkarma'
  endpoint: string;
  feedbackUri: string;
  feedbackHash: Uint8Array; // BytesN<32>
}

/** Encode give_feedback args in exact contract order/type (contract.rs). */
export function buildGiveFeedbackArgs(a: GiveFeedbackArgs): xdr.ScVal[] {
  if (a.feedbackHash.length !== 32) {
    throw new Error(`feedbackHash must be 32 bytes, got ${a.feedbackHash.length}`);
  }
  if (a.valueDecimals > 18) {
    throw new Error(`valueDecimals must be ≤18, got ${a.valueDecimals}`);
  }
  return [
    new Address(a.caller).toScVal(),
    nativeToScVal(a.agentId, { type: 'u32' }),
    nativeToScVal(a.value, { type: 'i128' }),
    nativeToScVal(a.valueDecimals, { type: 'u32' }),
    nativeToScVal(a.tag1, { type: 'string' }),
    nativeToScVal(a.tag2, { type: 'string' }),
    nativeToScVal(a.endpoint, { type: 'string' }),
    nativeToScVal(a.feedbackUri, { type: 'string' }),
    xdr.ScVal.scvBytes(Buffer.from(a.feedbackHash)),
  ];
}

// ─── Keypair handling (mirrors erc8004-celo-publish loadKeypair) ─────────────

/** Build a Keypair from a Stellar secret seed (S...). Raises if malformed. */
export function keypairFromSecret(secret: string): Keypair {
  return Keypair.fromSecret(secret);
}

export function validatorAddressFromSecret(secret: string): string {
  return keypairFromSecret(secret).publicKey();
}

/** Injectable fs seam for loadStellarKeypair (lets tests assert the 0600 gate). */
export interface LoadKeypairDeps {
  /** Read the keyfile contents (default: fs.readFileSync utf-8). */
  readFile?: (path: string) => string;
  /** Return the keyfile's permission bits, e.g. 0o600 (default: fs.statSync mode & 0o777). */
  fileMode?: (path: string) => number;
}

/**
 * Load AK's Stellar validator keypair. Precedence:
 *   1. STELLAR_PRIVATE_KEY env (secret seed S...) — no file, no mode check.
 *   2. .keys/agentkarma-stellar.json { "secret": "S..." }  (MUST be 0600, gitignored).
 *
 * The keyfile holds a secret seed, so we ASSERT it is 0600 (owner-only) rather
 * than merely claim it in a comment — a group/other-readable seed is a leak.
 * Raises if neither source is present, or if the keyfile is not 0600 — no silent
 * fallback (AK core rule).
 */
export function loadStellarKeypair(
  env: Readonly<Record<string, string | undefined>> = process.env,
  deps: LoadKeypairDeps = {},
): Keypair {
  if (env.STELLAR_PRIVATE_KEY) return Keypair.fromSecret(env.STELLAR_PRIVATE_KEY);

  const keyfile = resolve('.keys/agentkarma-stellar.json');
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf-8'));
  const fileMode = deps.fileMode ?? ((p: string) => statSync(p).mode & 0o777);

  const mode = fileMode(keyfile);
  if (mode !== 0o600) {
    throw new Error(
      `Stellar keyfile ${keyfile} has insecure permissions ${mode.toString(8).padStart(3, '0')} ` +
        `(must be 0600). Run: chmod 600 ${keyfile}`,
    );
  }

  const { secret } = JSON.parse(readFile(keyfile)) as { secret: string };
  return Keypair.fromSecret(secret);
}

/** AK's own validator G... (used as the client scope for get_summary reads). */
export function getValidatorAddress(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return loadStellarKeypair(env).publicKey();
}

// ─── publishStellarFeedback (simulate / execute) ─────────────────────────────

export interface PublishStellarFeedbackInput {
  agentId: number;
  value: bigint;
  valueDecimals: number;
  /** 'provider' | 'consumer' for karma scores; 'agentkarma_metadata' for the
   *  disclosed metadata-quality scheme (mirrors Celo AK_VALIDATOR.scheme). */
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackUri: string;
  feedbackHash: Uint8Array;
}

/**
 * How a submitted give_feedback actually ended up. `txId` is present whenever a
 * transaction reached the network, INCLUDING the two non-success states — the
 * hash is the only handle an operator has to look the attempt up on Horizon.
 *
 *  - `confirmed`     getTransaction returned SUCCESS. The attestation is on chain.
 *  - `failed`        getTransaction returned FAILED. Sequence consumed, nothing written.
 *  - `expired`       Never observed AND the account sequence never moved. The tx
 *                    carried timebounds (setTimeout below), so once they pass it
 *                    can never be included. Definitively not published.
 *  - `indeterminate` Never observed BUT the account sequence advanced — something
 *                    consumed this transaction's sequence number. Almost certainly
 *                    our own submission landing behind a blackholed RPC response.
 *                    Do NOT resend: the next run's get_summary dedupe read is the
 *                    ground truth and will skip the agent if the write landed.
 */
export type StellarPublishState = 'confirmed' | 'failed' | 'expired' | 'indeterminate';

export interface PublishStellarFeedbackResult {
  dryRun: boolean;
  agentId: number;
  txId?: string;
  /** Absent in simulate mode; always present after an execute attempt. */
  state?: StellarPublishState;
  /** Human-readable reason for a non-confirmed state. */
  detail?: string;
}

export interface PublishDeps {
  server?: rpc.Server;
  keypair?: Keypair;
  /**
   * Source account for a SIMULATE-only run, when no keypair is available.
   * Soroban's simulateTransaction needs a source account but no signature, so
   * a dry run must not require the secret — that is what lets the scheduled
   * job exercise the whole path (selection → gates → dedupe → simulate) before
   * anyone arms it with a signing key. Ignored in execute mode, where the
   * keypair defines the caller.
   */
  caller?: string;
  /**
   * Refuse to sign when the assembled fee exceeds this many stroops.
   *
   * The fee is only knowable AFTER simulation, so this is the last gate before
   * a signature: a balance check upstream cannot see it. Omitted = no ceiling,
   * which is only appropriate for a hand-driven single write.
   */
  maxFeeStroops?: number;
  /** Poll cadence for the confirmation wait. Default 2s (tests inject 0). */
  pollIntervalMs?: number;
  /** How long to wait for inclusion before falling back to the sequence check. */
  confirmTimeoutMs?: number;
}

/**
 * Transaction timebound, in seconds. Doubles as the safety boundary for the
 * whole confirm-vs-resend question: after maxTime the transaction can never be
 * included, so "not seen and sequence unchanged" is a proof of non-publication
 * rather than a guess.
 */
export const TX_TIMEOUT_SECONDS = 60;

/** Confirmation wait: the full timebound plus a ledger of slack (~6s closes). */
export const DEFAULT_CONFIRM_TIMEOUT_MS = (TX_TIMEOUT_SECONDS + 8) * 1000;

/**
 * What a `sendTransaction` status means for the confirmation wait. Pure, so the
 * four-way branch is unit-testable without a network.
 *
 *  - PENDING          accepted into the mempool → poll for inclusion.
 *  - DUPLICATE        this exact hash is already known → poll the SAME hash;
 *                     it is one transaction either way, not a second write.
 *  - TRY_AGAIN_LATER  rejected without entering the mempool (congestion, or the
 *                     node's recently-seen set). Poll anyway — the node's view
 *                     is not authoritative and a resend is never safe.
 *  - ERROR            malformed/rejected outright → raise.
 */
export function classifySendStatus(status: string): 'poll' | 'raise' {
  return status === 'ERROR' ? 'raise' : 'poll';
}

/** Error raised when the assembled fee exceeds the caller's ceiling. */
export interface FeeCeilingError extends Error {
  code: 'fee_ceiling';
  feeStroops: number;
  ceilingStroops: number;
}

/** Branch on the tagged code, never on message text. */
export function isFeeCeilingError(err: unknown): err is FeeCeilingError {
  return err instanceof Error && (err as Partial<FeeCeilingError>).code === 'fee_ceiling';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sign and submit give_feedback on the Reputation Registry.
 *  - 'simulate' → dry-run, never signs/sends, never needs the secret.
 *  - 'execute'  → simulate, assemble, sign, send, then WAIT for inclusion.
 * Raises on any simulate/send error (AK core rule — no silent fallback).
 *
 * The wait is not optional politeness: the Soroban RPC drops a meaningful share
 * of send responses while the transaction still lands. Returning a bare hash
 * would leave the caller unable to tell "wrote it" from "wrote it twice", so
 * every execute resolves to one of the four {@link StellarPublishState} values
 * and this function NEVER resends on its own.
 */
export async function publishStellarFeedback(
  input: PublishStellarFeedbackInput,
  mode: 'simulate' | 'execute' = 'simulate',
  deps: PublishDeps = {},
): Promise<PublishStellarFeedbackResult> {
  const server = deps.server ?? new rpc.Server(resolveStellarRpcUrl(), { allowHttp: false });
  // Simulate never signs, so it never touches the keyfile: an unarmed dry run
  // must exercise the real path, not fail on a missing secret.
  const keypair = deps.keypair ?? (mode === 'execute' ? loadStellarKeypair() : null);
  const caller = keypair?.publicKey() ?? deps.caller ?? AK_STELLAR.account;

  const source = await server.getAccount(caller);
  // Capture BEFORE build: TransactionBuilder consumes (and increments) the
  // account's sequence, and this value is what the blackhole check compares to.
  const seqBefore = BigInt(source.sequenceNumber());
  const contract = new Contract(STELLAR_REPUTATION_REGISTRY);
  const args = buildGiveFeedbackArgs({ caller, ...input });

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call('give_feedback', ...args))
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();

  const sim = (await server.simulateTransaction(tx)) as { error?: string };
  if (sim.error) {
    throw new Error(`give_feedback simulate failed (agent ${input.agentId}): ${sim.error}`);
  }

  if (mode === 'simulate') {
    return { dryRun: true, agentId: input.agentId };
  }
  if (!keypair) {
    throw new Error('execute mode requires a keypair (STELLAR_PRIVATE_KEY or .keys/agentkarma-stellar.json)');
  }

  const prepared = rpc
    .assembleTransaction(tx, sim as rpc.Api.SimulateTransactionSuccessResponse)
    .build();

  // Last gate before a signature. The resource fee is a property of network
  // state, not of our payload, so it can move by orders of magnitude between
  // runs — refuse rather than sign whatever the simulation came back with.
  const fee = Number(prepared.fee);
  if (deps.maxFeeStroops !== undefined && fee > deps.maxFeeStroops) {
    throw Object.assign(
      new Error(
        `fee ceiling exceeded (agent ${input.agentId}): assembled fee ${(fee / 1e7).toFixed(4)} XLM ` +
          `> ceiling ${(deps.maxFeeStroops / 1e7).toFixed(4)} XLM. Nothing signed, nothing sent.`,
      ),
      { code: 'fee_ceiling' as const, feeStroops: fee, ceilingStroops: deps.maxFeeStroops },
    );
  }

  prepared.sign(keypair);
  const sent = await server.sendTransaction(prepared);
  if (classifySendStatus(sent.status) === 'raise') {
    throw new Error(
      `give_feedback send failed (agent ${input.agentId}): ${JSON.stringify(sent.errorResult ?? sent)}`,
    );
  }

  const settled = await awaitStellarInclusion(server, {
    hash: sent.hash,
    caller,
    seqBefore,
    sendStatus: sent.status,
    pollIntervalMs: deps.pollIntervalMs ?? 2000,
    timeoutMs: deps.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS,
  });

  return { dryRun: false, agentId: input.agentId, txId: sent.hash, ...settled };
}

interface InclusionArgs {
  hash: string;
  caller: string;
  seqBefore: bigint;
  sendStatus: string;
  pollIntervalMs: number;
  timeoutMs: number;
}

/**
 * Poll for inclusion, then fall back to the account sequence.
 *
 * The sequence fallback is what makes a blackholed submission safe to leave
 * alone: a transaction's sequence number is consumed exactly once, so an
 * advanced sequence means this submission (the only one this process sent) was
 * included — whether or not the RPC ever admitted it. An unchanged sequence
 * past the timebound means it never was, and never can be.
 */
export async function awaitStellarInclusion(
  server: rpc.Server,
  a: InclusionArgs,
): Promise<{ state: StellarPublishState; detail?: string }> {
  const deadline = Date.now() + a.timeoutMs;

  while (Date.now() < deadline) {
    await sleep(a.pollIntervalMs);
    let got: { status?: string; resultXdr?: unknown } | null = null;
    try {
      got = (await server.getTransaction(a.hash)) as { status?: string };
    } catch {
      got = null; // RPC hiccup — keep polling; the deadline bounds the wait.
    }
    if (got?.status === 'SUCCESS') return { state: 'confirmed' };
    if (got?.status === 'FAILED') {
      return { state: 'failed', detail: 'getTransaction returned FAILED' };
    }
  }

  // Never observed. Ask the ledger, not the RPC's memory: did our sequence move?
  try {
    const after = await server.getAccount(a.caller);
    if (BigInt(after.sequenceNumber()) > a.seqBefore) {
      return {
        state: 'indeterminate',
        detail:
          `tx never observed (send status ${a.sendStatus}) but account sequence advanced ` +
          `${a.seqBefore} → ${after.sequenceNumber()} — it most likely landed. NOT resending.`,
      };
    }
    return {
      state: 'expired',
      detail: `tx never included and sequence unchanged at ${a.seqBefore} — timebound passed, cannot land`,
    };
  } catch (err) {
    return {
      state: 'indeterminate',
      detail: `tx never observed and the sequence re-read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── publishStellarScore (idempotent, badge-gated) ───────────────────────────

/** Min score change to justify a new on-chain write (mirrors publish.ts). */
export const DELTA_THRESHOLD = 3;

export interface PublishStellarScoreArgs {
  score: WalletScore;
  agentId: number | null;
  validatorAddress: string;
  mode?: 'simulate' | 'execute';
  deps?: PublishDeps;
}

/**
 * Publish a karma score → give_feedback, with the same idempotency guard
 * publish.ts uses on Solana: skip when |new − onChain| < DELTA_THRESHOLD.
 * Badge-gated: a wallet with no stellar_agent_id is SKIPPED (never minted),
 * mirroring the Celo identity gate. Returns the shared PublishResult contract.
 * tag1 is provider-face here.
 */
export async function publishStellarScore(a: PublishStellarScoreArgs): Promise<PublishResult> {
  const { score, agentId } = a;
  const mode = a.mode ?? 'simulate';

  // Identity gating (spec §2): no agentId → badge-gated, never written.
  if (agentId == null) {
    return {
      address: score.address,
      dryRun: mode === 'simulate',
      skipped: true,
      reason: 'no_stellar_agent_id',
    };
  }

  const server = a.deps?.server ?? new rpc.Server(resolveStellarRpcUrl(), { allowHttp: false });

  // Idempotency: read AK's own current on-chain summary for this agent.
  let onChain: number | null = null;
  try {
    const summary = await readStellarSummary(server, agentId, [a.validatorAddress], 'provider', AK_TAG2);
    onChain = summary.count === 0 ? null : Math.round(summary.summaryValue);
  } catch {
    onChain = null; // treat read failure as "not yet published"
  }

  const newScore = Math.round(score.providerScore);
  if (onChain != null) {
    const delta = Math.abs(newScore - onChain);
    if (delta < DELTA_THRESHOLD) {
      return {
        address: score.address,
        dryRun: mode === 'simulate',
        skipped: true,
        reason: `delta ${delta} < threshold ${DELTA_THRESHOLD}`,
      };
    }
  }

  // Inline the score attestation as a data: URI so the URI's CONTENT is exactly
  // what feedbackHash covers (sha256 of the same JSON) — a verifier can decode,
  // hash, and reconcile. Previously feedbackUri pointed at the HTML profile page
  // while feedbackHash hashed this JSON, so the two never matched. The profile
  // link is preserved inside the payload. (Server-side: Buffer is available.)
  const payload = {
    address: score.address,
    providerScore: score.providerScore,
    consumerScore: score.consumerScore,
    trustTier: score.trustTier,
    confidenceBadge: score.confidenceBadge,
    profile: `https://agentkarma.io/agent/${score.address}`,
  };
  const feedbackUri = `data:application/json;base64,${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
  const feedbackHash = feedbackHashFromJson(payload);

  const result = await publishStellarFeedback(
    {
      agentId,
      value: BigInt(newScore),
      valueDecimals: 0,
      tag1: 'provider',
      tag2: AK_TAG2,
      endpoint: '',
      feedbackUri,
      feedbackHash,
    },
    mode,
    a.deps,
  );

  return { address: score.address, txId: result.txId, dryRun: result.dryRun, skipped: false };
}
