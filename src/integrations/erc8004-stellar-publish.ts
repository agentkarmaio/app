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
  tag1: 'provider' | 'consumer';
  tag2: string;
  endpoint: string;
  feedbackUri: string;
  feedbackHash: Uint8Array;
}

export interface PublishStellarFeedbackResult {
  dryRun: boolean;
  agentId: number;
  txId?: string;
}

export interface PublishDeps {
  server?: rpc.Server;
  keypair?: Keypair;
}

/**
 * Sign and submit give_feedback on the Reputation Registry.
 *  - 'simulate' → dry-run, never signs/sends.
 *  - 'execute'  → simulate, assemble, sign, send.
 * Raises on any simulate/send error (AK core rule — no silent fallback).
 */
export async function publishStellarFeedback(
  input: PublishStellarFeedbackInput,
  mode: 'simulate' | 'execute' = 'simulate',
  deps: PublishDeps = {},
): Promise<PublishStellarFeedbackResult> {
  const server = deps.server ?? new rpc.Server(resolveStellarRpcUrl(), { allowHttp: false });
  const keypair = deps.keypair ?? loadStellarKeypair();
  const caller = keypair.publicKey();

  const source = await server.getAccount(caller);
  const contract = new Contract(STELLAR_REPUTATION_REGISTRY);
  const args = buildGiveFeedbackArgs({ caller, ...input });

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call('give_feedback', ...args))
    .setTimeout(60)
    .build();

  const sim = (await server.simulateTransaction(tx)) as { error?: string };
  if (sim.error) {
    throw new Error(`give_feedback simulate failed (agent ${input.agentId}): ${sim.error}`);
  }

  if (mode === 'simulate') {
    return { dryRun: true, agentId: input.agentId };
  }

  const prepared = rpc
    .assembleTransaction(tx, sim as rpc.Api.SimulateTransactionSuccessResponse)
    .build();
  prepared.sign(keypair);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') {
    throw new Error(
      `give_feedback send failed (agent ${input.agentId}): ${JSON.stringify(sent.errorResult ?? sent)}`,
    );
  }
  return { dryRun: false, agentId: input.agentId, txId: sent.hash };
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
