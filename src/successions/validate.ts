/**
 * Succession declaration validation — pure, IO-free.
 *
 * A succession plan is `interval_seconds` + an ordered list of heirs. AK only
 * OBSERVES the public lifecycle and scores it; it NEVER holds a key, holds
 * funds, or executes a will (RFC §12 Non-Routing AND Non-Custody). This module
 * validates a declared plan from either source (`claim_form` | `self_hosted`)
 * before it is upserted into `successions`.
 *
 * Rules enforced here:
 *   - interval_seconds within sane bounds (MIN_INTERVAL_SECONDS .. MAX_INTERVAL_SECONDS).
 *   - 1..MAX_HEIRS heirs; each heir address valid for its declared chain.
 *   - reject self-as-sole-heir (declaring the agent as its only heir is a no-op
 *     dead-man's switch — there is no successor).
 *   - optional per-heir `share` must be a positive finite number when present.
 */

import { isChain, type Chain, type SuccessionHeir } from '@/db/schema';
import { getAdapter } from '@/chain-adapters/registry';

/** One hour — fast enough for demos, slow enough to never false-lapse a healthy agent. */
export const MIN_INTERVAL_SECONDS = 3_600;
/** 365 days — a yearly heartbeat is the loosest cadence we will derive liveness from. */
export const MAX_INTERVAL_SECONDS = 365 * 24 * 60 * 60;
/** Hard cap on declared heirs — keeps the jsonb payload bounded. */
export const MAX_HEIRS = 16;

export interface SuccessionPlanInput {
  /** Declared heartbeat cadence in seconds. */
  intervalSeconds: number;
  /** Ordered heirs with optional split weights. */
  heirs: SuccessionHeir[];
}

export interface ValidatedSuccessionPlan {
  intervalSeconds: number;
  heirs: SuccessionHeir[];
}

export type SuccessionValidationError =
  | { ok: false; error: string };

export type SuccessionValidationResult =
  | { ok: true; plan: ValidatedSuccessionPlan }
  | SuccessionValidationError;

/**
 * Validate + normalize a raw succession plan against the declaring agent's
 * (chain, wallet). Returns a discriminated result — never throws on bad input.
 *
 * `agentChain` / `agentWallet` are the declaring agent's identity, needed to
 * reject self-as-sole-heir.
 */
export function validateSuccessionPlan(
  raw: unknown,
  agentChain: Chain,
  agentWallet: string,
): SuccessionValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'succession plan must be an object' };
  }
  const obj = raw as Record<string, unknown>;

  const intervalSeconds = Number(obj.intervalSeconds ?? obj.interval_seconds);
  if (!Number.isFinite(intervalSeconds) || !Number.isInteger(intervalSeconds)) {
    return { ok: false, error: 'intervalSeconds must be an integer number of seconds' };
  }
  if (intervalSeconds < MIN_INTERVAL_SECONDS) {
    return { ok: false, error: `intervalSeconds must be at least ${MIN_INTERVAL_SECONDS} (1 hour)` };
  }
  if (intervalSeconds > MAX_INTERVAL_SECONDS) {
    return { ok: false, error: `intervalSeconds must be at most ${MAX_INTERVAL_SECONDS} (365 days)` };
  }

  const rawHeirs = obj.heirs;
  if (!Array.isArray(rawHeirs) || rawHeirs.length === 0) {
    return { ok: false, error: 'heirs must be a non-empty array' };
  }
  if (rawHeirs.length > MAX_HEIRS) {
    return { ok: false, error: `heirs must contain at most ${MAX_HEIRS} entries` };
  }

  const heirs: SuccessionHeir[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawHeirs.length; i++) {
    const result = validateHeir(rawHeirs[i], i);
    if (!result.ok) return result;
    const heir = result.heir;

    // De-dup identical (chain,address) heirs — declaring the same heir twice is
    // almost certainly an error and would double-weight a split.
    const key = `${heir.chain}:${heir.address}`;
    if (seen.has(key)) {
      return { ok: false, error: `duplicate heir at index ${i}: ${key}` };
    }
    seen.add(key);
    heirs.push(heir);
  }

  // Reject self-as-sole-heir: a single heir that is the declaring agent itself
  // is a no-op switch (no successor). A self-heir is allowed only when there is
  // at least one OTHER distinct heir (e.g. a "primary keeps a share" split).
  const selfKey = `${agentChain}:${agentWallet}`;
  const distinctNonSelf = heirs.filter((h) => `${h.chain}:${h.address}` !== selfKey);
  if (distinctNonSelf.length === 0) {
    return { ok: false, error: 'the declaring agent cannot be its own sole heir' };
  }

  return { ok: true, plan: { intervalSeconds, heirs } };
}

function validateHeir(
  raw: unknown,
  index: number,
): { ok: true; heir: SuccessionHeir } | SuccessionValidationError {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: `heir at index ${index} must be an object` };
  }
  const obj = raw as Record<string, unknown>;

  const address = obj.address;
  if (typeof address !== 'string' || address.length === 0) {
    return { ok: false, error: `heir at index ${index} is missing an address` };
  }

  const chainVal = obj.chain;
  if (!isChain(chainVal)) {
    return { ok: false, error: `heir at index ${index} has an invalid or missing chain` };
  }

  // Per-chain format validation via the chain adapter (never auto-detect EVM
  // chain from address — the heir's chain is declared explicitly).
  if (!getAdapter(chainVal).validateAddress(address)) {
    return { ok: false, error: `heir at index ${index} address is not valid for chain ${chainVal}` };
  }

  const heir: SuccessionHeir = { address, chain: chainVal };

  if (obj.share != null) {
    const share = Number(obj.share);
    if (!Number.isFinite(share) || share <= 0) {
      return { ok: false, error: `heir at index ${index} has a non-positive share` };
    }
    heir.share = share;
  }

  if (typeof obj.label === 'string' && obj.label.trim().length > 0) {
    heir.label = obj.label.trim().slice(0, 120);
  }

  return { ok: true, heir };
}
