/**
 * Shared outbound-RPC throttle handling.
 *
 * Every chain we read lives behind a rate-limited public RPC: Soroban 429s a
 * full sweep after ~15 agents, and Arc Testnet answers `-32005 rate limit
 * exceeded` once a sequential loop gets going (the arc-farm-detector job failed
 * on this every run from 2026-07-27 onward). Both need the same shape — retry
 * ONLY throttles, never contract reverts, with exponential backoff and jitter.
 *
 * This is transport-agnostic on purpose: `isRateLimitedError` inspects both the
 * message (Stellar SDK surfaces "429"/"Too Many Requests" as text) and a numeric
 * JSON-RPC `code` (viem raises LimitExceededRpcError, whose message is the
 * unhelpful "Request exceeds defined limit." — only `code === -32005` and the
 * `details` field carry the real signal).
 *
 * Do NOT push this into the shared viem clients: `erc8004-arc.ts` deliberately
 * fails fast (retryCount: 1) so a wedged RPC can't hold a profile render. Retry
 * at the batch-job call site, where waiting is correct.
 */

import { sleep, withRetry, type RetryOpts } from './retry';

/** JSON-RPC "limit exceeded" — viem's LimitExceededRpcError.code. */
const LIMIT_EXCEEDED_RPC_CODE = -32005;

/**
 * Distinguish an RPC throttle from a contract revert. A revert means "this
 * agentId does not exist" and must NEVER be retried; a throttle means "ask
 * again later" and must never be counted as missing.
 */
export function isRateLimited(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    message.includes('429') ||
    lower.includes('too many requests') ||
    lower.includes('rate limit')
  );
}

/**
 * Throttle detection for a thrown value rather than a message string. Prefer
 * this at call sites: viem hides the useful text in `details`/`code`, so a
 * message-only check misses every Arc rate limit.
 */
export function isRateLimitedError(err: unknown): boolean {
  if (err == null) return false;
  const record = err as { code?: unknown; details?: unknown; cause?: unknown };
  if (record.code === LIMIT_EXCEEDED_RPC_CODE) return true;
  if (typeof record.details === 'string' && isRateLimited(record.details)) return true;
  const message = err instanceof Error ? err.message : String(err);
  if (isRateLimited(message)) return true;
  // viem wraps the transport error; the code only survives on the cause chain.
  return record.cause != null && record.cause !== err && isRateLimitedError(record.cause);
}

/** Retry knobs, under the name the Stellar/Arc call sites already use. */
export type RateLimitRetryOpts = RetryOpts;

/**
 * Budget for a scheduled INGEST run, where wall clock is the scarce resource.
 *
 * The defaults (5 retries from 1.5s) can spend ~46s on a single throttled call.
 * That is right for a weekly alert-only sampler, and wrong for the keep-fresh
 * floor: Arc's escrow indexer makes 2 getLogs per window across up to 50
 * windows, so the default budget stretched a 9-minute run past 30 minutes
 * (2026-08-10). Cursor-based indexers lose nothing by stopping early — the next
 * scheduled run resumes from the same cursor — so give up fast and come back.
 */
export const INGEST_RETRY: RateLimitRetryOpts = { retries: 2, baseMs: 800 };

export { sleep };

/** Run `fn`, retrying ONLY on rate-limit errors with exponential backoff. */
export function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  opts: RateLimitRetryOpts = {},
): Promise<T> {
  return withRetry(fn, isRateLimitedError, opts);
}
