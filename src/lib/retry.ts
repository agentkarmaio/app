/**
 * Generic "the other side was busy, ask again" retry with exponential backoff.
 *
 * Deliberately knows nothing about transports: callers supply `isRetryable`,
 * which is where the real judgment lives — a throttle is retryable, a contract
 * revert or a foreign-key violation is a bug and must surface on attempt one.
 *
 * Two concrete classifiers build on this: `@/lib/rpc-retry` (public-RPC
 * throttles) and the transient-Postgres retry in `@/db/client`.
 */

export interface RetryOpts {
  /** Retries AFTER the initial attempt. Default 5. */
  retries?: number;
  /** First backoff step in ms; doubles each retry. Default 1500. */
  baseMs?: number;
  /** ±25% jitter so parallel workers don't retry in lockstep. Default true. */
  jitter?: boolean;
  /** Called before each backoff, for logging. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn`, retrying ONLY errors `isRetryable` accepts. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  isRetryable: (err: unknown) => boolean,
  opts: RetryOpts = {},
): Promise<T> {
  const { retries = 5, baseMs = 1500, jitter = true, onRetry } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= retries) throw err;
      const factor = jitter ? 0.75 + Math.random() * 0.5 : 1;
      const delayMs = baseMs * 2 ** attempt * factor;
      onRetry?.(err, attempt + 1, delayMs);
      await sleep(delayMs);
    }
  }
}
