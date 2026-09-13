import type { ScanOutcome } from './indexing-runner';

export interface IndexingPageInput extends Omit<ScanOutcome, 'status'> {
  status: ScanOutcome['status'] | 'busy' | 'lease_lost';
  /** The run banked no new ground while a known backlog waited. */
  stalled?: boolean;
}

/**
 * A backlog that no longer moves is the failure worth waking someone for: the
 * cursor sat still, nothing was examined and nothing landed, yet work waits.
 * Bounded runs that still scanned or inserted are progress, however slow.
 */
export function isIndexingStalled(
  previous: { checkpoint: string | null } | null,
  outcome: ScanOutcome,
): boolean {
  if (!previous) return false;
  const checkpoint = outcome.checkpoint ?? null;
  // Paths that never report a cursor give no evidence either way; "both null"
  // is absence of data, not proof the cursor stood still.
  if (checkpoint === null && previous.checkpoint === null) return false;
  if ((outcome.pendingCount ?? 0) <= 0) return false;
  if ((outcome.checkedCount ?? 0) > 0 || (outcome.insertedCount ?? 0) > 0)
    return false;
  return checkpoint === previous.checkpoint;
}

/**
 * Splits a run into "a human must act" and "known, disclosed debt".
 *
 * Retained `gapCount` and `unresolvedCount` are deliberately NOT page
 * conditions: both are durable ledgers that survive successful scans by
 * design, so paging on them turns one transient event into an alert that
 * repeats on every schedule until an operator edits the database (2026-09-12).
 * Incompleteness belongs in the health surface; only faults and stalls page.
 */
export function shouldPageIndexingOutcome(outcome: IndexingPageInput): boolean {
  if (outcome.status === 'busy') return false;
  if (outcome.status === 'lease_lost' || outcome.status === 'failed')
    return true;
  return outcome.stalled === true;
}
