/**
 * Policy layer for AgentKarma's disclosed metadata-quality attestations on
 * Stellar — what may be published, to whom, and whether the account can pay
 * for it. The read path is `erc8004-stellar.ts`, the write path is
 * `erc8004-stellar-publish.ts`; this module holds the decisions that sit
 * between them, as pure functions so the gates are unit-testable.
 *
 * The gates exist because an attestation is permanent and public:
 *
 *  - AK never rates its own registration (the contract blocks self-feedback
 *    anyway; refusing early keeps the reason legible).
 *  - AK never publishes a score derived from metadata it could not read. An
 *    unreachable https URL IS a quality signal the rubric already prices in,
 *    but an ipfs:// / ar:// URI is OUR fetcher's gap — publishing a 0 for it
 *    would attest our limitation as the agent's quality. Skipping is correct.
 *  - AK publishes only at or above a score floor. Below-threshold agents get
 *    silence, not a low broadcast: an off-chain hosting hiccup should not earn
 *    a permanent bad mark. Silence is not a negative signal in this scheme.
 *
 * Balance handling is deliberately a hard failure rather than a warning: a
 * cadence that cannot pay Soroban fees is worse than no cadence, because it
 * fails on the invisible side. Note this reads AK's OWN account only — no
 * target account is ever fetched from Horizon, so the 2026-08 absent-target
 * alert shape (a never-funded account 404ing for six hours) cannot arise here.
 */

import type { StellarAgent } from './erc8004-stellar';
import { resolveHorizonUrl, isHorizonNotFound } from '@/indexer/stellar-activity';
import { AK_STELLAR } from '@/config/ak-validator';

// ─── Policy constants ───────────────────────────────────────────────────────

/**
 * Minimum metadata-quality score AK will publish. Mirrors the Celo drip's
 * `--min 70` default — same rubric, same positive-bias policy.
 */
export const ATTEST_MIN_SCORE = 70;

/**
 * Writes per scheduled run. Small on purpose: the eligible Stellar population
 * is tens of agents, not thousands, so a bounded trickle both spreads the
 * records across days and keeps a single bad run's blast radius to 3 records.
 */
export const ATTEST_BATCH_SIZE = 3;

/**
 * XLM floor below which the run refuses to write. Base reserve holds 1 XLM
 * hostage and a Soroban invoke costs well under 0.01 XLM, so this is ~4 XLM of
 * genuine headroom — hundreds of attestations — not a tight budget.
 */
export const MIN_XLM_BALANCE = 5;

// ─── Target gating (pure) ───────────────────────────────────────────────────

export type AttestDecision =
  | 'publish'
  | 'skipped_self'
  | 'not_registered'
  | 'unsupported_uri'
  | 'unresolved'
  | 'below_threshold';

export interface ClassifyTargetArgs {
  /** Live on-chain read; null when the agentId is not registered. */
  agent: StellarAgent | null;
  /** Metadata-quality score from the v0.2 rubric, or null when not computed. */
  score: number | null;
  /** AK's own Stellar account — an agent it owns can never be rated by AK. */
  akAccount: string;
  minScore?: number;
}

export interface AttestVerdict {
  decision: AttestDecision;
  /** Why, in one line — carried into the run summary. */
  reason?: string;
}

/**
 * Decide whether one agent may receive an AK attestation right now.
 *
 * Order matters: identity and readability are checked before the score, so a
 * skip always names its real cause rather than reporting an artificial 0.
 */
export function classifyTarget(a: ClassifyTargetArgs): AttestVerdict {
  const min = a.minScore ?? ATTEST_MIN_SCORE;
  const { agent } = a;

  if (!agent) return { decision: 'not_registered', reason: 'no such agentId on the registry' };
  if (agent.owner === a.akAccount) {
    return { decision: 'skipped_self', reason: "AK's own registration" };
  }

  // OUR fetcher's gap, not the agent's quality — never priced as a score.
  if (agent.registrationError?.includes('unsupported URI scheme')) {
    return {
      decision: 'unsupported_uri',
      reason: `metadata on a scheme we cannot resolve (${agent.agentURI.slice(0, 12)}…)`,
    };
  }
  // No registration at all: the rubric has nothing to grade honestly.
  if (!agent.registration) {
    return {
      decision: 'unresolved',
      reason: agent.registrationError ?? 'registration JSON did not resolve',
    };
  }

  if (a.score == null) return { decision: 'unresolved', reason: 'score not computed' };
  if (a.score < min) {
    return { decision: 'below_threshold', reason: `score ${a.score} < ${min}` };
  }
  return { decision: 'publish' };
}

// ─── Assessment payload (shared by the single-target and batch scripts) ─────

export interface AssessmentInput {
  agentId: number;
  akAccount: string;
  scheme: string;
  version: string;
  score: number;
  breakdown: Record<string, number>;
  notes: string[];
  /** Injectable for deterministic tests. */
  now?: () => Date;
}

export interface StellarAssessment {
  payload: Record<string, unknown>;
  /** Inline data: URI whose CONTENT is exactly what the hash covers. */
  feedbackUri: string;
}

/**
 * Build the off-chain assessment and its inline data: URI.
 *
 * The URI inlines the payload on purpose: `feedbackHash` is sha256 of this
 * same JSON, so a verifier can decode the URI, hash it, and reconcile. A URI
 * pointing at a mutable page would break that parity the moment the page
 * changed. Callers hash `assessment.payload` with `feedbackHashFromJson`.
 */
export function buildStellarAssessment(a: AssessmentInput): StellarAssessment {
  const payload = {
    rater: 'AgentKarma',
    raterAccount: a.akAccount,
    chain: 'stellar',
    target: a.agentId,
    scheme: a.scheme,
    version: a.version,
    score: a.score,
    breakdown: a.breakdown,
    notes: a.notes,
    generatedAt: (a.now?.() ?? new Date()).toISOString(),
  };
  const feedbackUri = `data:application/json;base64,${Buffer.from(
    JSON.stringify(payload),
  ).toString('base64')}`;
  return { payload, feedbackUri };
}

// ─── Fee-account preflight ──────────────────────────────────────────────────

export type BalanceState = 'ok' | 'low' | 'absent';

export interface AccountBalance {
  state: BalanceState;
  /** Native XLM balance; 0 when the account is absent. */
  xlm: number;
  /** Current account sequence — the handle the blackhole check compares against. */
  sequence: string | null;
}

/** Injected transport so the preflight is testable without Horizon. */
export type HorizonJsonFetch = (url: string) => Promise<unknown>;

interface HorizonAccount {
  sequence?: string;
  balances?: Array<{ asset_type?: string; balance?: string }>;
}

async function defaultFetch(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Horizon ${res.status} ${res.statusText} for ${url}`), {
      status: res.status,
    });
  }
  return res.json();
}

/**
 * Read AK's native XLM balance and sequence from Horizon.
 *
 * A 404 returns `absent` rather than throwing — an unfunded signing account is
 * a distinct, actionable state ("fund it") and the caller reports it as such.
 * Every other Horizon failure raises: not knowing the balance is not the same
 * as knowing it is fine.
 */
export async function readStellarFeeAccount(
  account: string = AK_STELLAR.account,
  opts: { fetchJson?: HorizonJsonFetch; horizonUrl?: string; minXlm?: number; timeoutMs?: number } = {},
): Promise<AccountBalance> {
  const base = resolveHorizonUrl(opts.horizonUrl);
  const fetchJson = opts.fetchJson ?? ((url: string) => defaultFetch(url, opts.timeoutMs ?? 10_000));

  let body: HorizonAccount;
  try {
    body = (await fetchJson(`${base}/accounts/${account}`)) as HorizonAccount;
  } catch (err) {
    if (isHorizonNotFound(err)) return { state: 'absent', xlm: 0, sequence: null };
    throw err;
  }

  const native = body.balances?.find((b) => b.asset_type === 'native');
  const xlm = Number(native?.balance ?? 0);
  return {
    state: xlm >= (opts.minXlm ?? MIN_XLM_BALANCE) ? 'ok' : 'low',
    xlm,
    sequence: body.sequence ?? null,
  };
}
