import { INGEST_RETRY, isRateLimitedError, type RateLimitRetryOpts } from '@/lib/rpc-retry';
import { withRetry } from '@/lib/retry';
import type { IndexRunResult } from '@/chain-adapters/types';

export interface ArcIndexCoverage {
  complete: boolean;
  /** Empty only when no head was requested (an empty transfer seed). */
  head: string;
  checkpoint: string | null;
  /** Fully processed blocks in this run; pending is the unread block backlog. */
  checked: number;
  pending: number;
  /** Unattributed releases or unknown coverage intervals; not a record count. */
  unresolved: number;
  reason?: 'rate_limited' | 'budget' | 'unmatched' | 'empty_seed' | 'head_behind_cursor';
}

export interface ArcIndexRunResult extends IndexRunResult {
  coverage: ArcIndexCoverage;
}

/** Recovery is deliberately bounded even when an RPC permits only tiny reads. */
export const ARC_LOG_RANGE_MAX_REQUESTS = 63;
export const ARC_LOG_BUDGET_EXHAUSTED = new Error('Arc log scan time budget exhausted');

/** Inspect provider details without treating every -32005/HTTP 400 as a range limit. */
export function isArcLogRangeError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (current != null && !visited.has(current)) {
    visited.add(current);
    const record = current as { message?: unknown; details?: unknown; cause?: unknown };
    const message = [record.message, record.details, typeof current === 'string' ? current : '']
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
    if (
      /ranges? over \d+ blocks? (?:are|is) not supported/i.test(message)
      || /block[\s-]*range[^\n]*(?:too (?:large|wide)|exceed|limit|maximum|at most)/i.test(message)
      || /(?:maximum|max|limited to)[^\n]*block[\s-]*range/i.test(message)
      || /query returned more than[^\n]*(?:results|logs)/i.test(message)
      || /(?:too many|maximum|exceeds?[^\n]*limit)[^\n]*(?:results|logs)/i.test(message)
      || /(?:response|result) size[^\n]*(?:exceed|too large|limit)/i.test(message)
    ) return true;
    current = record.cause;
  }
  return false;
}

/** Range/result limits need subdivision, not a throttle backoff for every half. */
export function withArcLogRetry<T>(read: () => Promise<T>, opts: RateLimitRetryOpts = INGEST_RETRY): Promise<T> {
  return withRetry(read, (error) => !isArcLogRangeError(error) && isRateLimitedError(error), opts);
}

/**
 * Recover transport subranges, then merge before the caller attributes events.
 * No partial result escapes: a failed half means the logical window is unread.
 * A single-block denial remains an error, never a reason to jump a checkpoint.
 */
export async function readArcLogRange<T>(
  from: bigint,
  to: bigint,
  read: (from: bigint, to: bigint) => Promise<T>,
  merge: (left: T, right: T) => T,
  expired: () => boolean = () => false,
  signal?: AbortSignal,
): Promise<T> {
  let requests = 0;
  const visit = async (lower: bigint, upper: bigint): Promise<T> => {
    signal?.throwIfAborted();
    if (expired()) throw ARC_LOG_BUDGET_EXHAUSTED;
    if (requests >= ARC_LOG_RANGE_MAX_REQUESTS) throw new Error('Arc log range recovery limit exhausted');
    requests++;
    try {
      const result = await read(lower, upper);
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      if (!isArcLogRangeError(error) || lower === upper) throw error;
      const middle = lower + (upper - lower) / 2n;
      const left = await visit(lower, middle);
      const right = await visit(middle + 1n, upper);
      return merge(left, right);
    }
  };
  return visit(from, to);
}

export function arcIndexCoverage(
  head: bigint,
  start: bigint,
  checkpoint: bigint,
  previousCheckpoint: number | null,
  unresolved = 0,
  stopped?: ArcIndexCoverage['reason'],
): ArcIndexCoverage {
  if (checkpoint > head) {
    return { complete: false, head: String(head), checkpoint: previousCheckpoint == null ? null : String(previousCheckpoint),
      checked: 0, pending: 0, unresolved: Math.max(1, unresolved), reason: 'head_behind_cursor' };
  }
  const checked = Math.max(0, Number(checkpoint - start + 1n));
  const pending = Math.max(0, Number(head - checkpoint));
  const reason = stopped ?? (pending > 0 ? 'budget' : unresolved > 0 ? 'unmatched' : undefined);
  return {
    complete: pending === 0 && unresolved === 0 && reason === undefined,
    head: String(head),
    checkpoint: checked > 0 ? String(checkpoint) : previousCheckpoint == null ? null : String(previousCheckpoint),
    checked,
    pending,
    unresolved,
    ...(reason ? { reason } : {}),
  };
}
