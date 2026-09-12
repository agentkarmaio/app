import { supabase } from './client';
import type { Chain } from './schema';
import type { IndexingPath } from './indexing-context';

export type IndexingOutcome = 'caught_up' | 'catching_up' | 'dormant' | 'failed';
export interface IndexingState {
  chain: Chain;
  path: IndexingPath;
  enabled: boolean;
  status: IndexingOutcome | null;
  last_attempt_at: string | null;
  /** Last complete scan with no pending or unresolved coverage. */
  last_success_at: string | null;
  last_finished_at: string | null;
  error_code: string | null;
  checkpoint: string | null;
  head: string | null;
  checked_count: number;
  pending_count: number;
  inserted_count: number;
  unresolved_count: number;
  /** Historical coverage gaps; only explicit operator recovery may clear. */
  gaps_count: number;
  interval_ms: number;
  owner: string | null;
  lease_until: string | null;
  generation: number;
}
export interface IndexingLeaseKey { chain: Chain; path: IndexingPath; owner: string }
export interface AcquireIndexingLeaseInput extends IndexingLeaseKey {
  leaseMs: number;
  intervalMs: number;
  /** Initial state only. An existing disabled path requires explicit DB enable. */
  enabled?: boolean;
}
export interface FinishIndexingRunInput extends IndexingLeaseKey {
  status: IndexingOutcome;
  /** Bounded stable classification only, never an RPC message/URL. */
  errorCode?: string;
  checkpoint?: string;
  head?: string;
  checkedCount?: number;
  pendingCount?: number;
  insertedCount?: number;
  unresolvedCount?: number;
  gapCount?: number;
}

export async function acquireIndexingLease(input: AcquireIndexingLeaseInput): Promise<IndexingState | null> {
  const { data, error } = await supabase.rpc('acquire_indexing_lease', {
    p_chain: input.chain, p_path: input.path, p_owner: input.owner,
    p_lease_ms: input.leaseMs, p_interval_ms: input.intervalMs, p_enabled: input.enabled ?? true,
  });
  if (error) throw error;
  return (data as IndexingState[] | null)?.[0] ?? null;
}

export async function renewIndexingLease(input: IndexingLeaseKey & { leaseMs: number }): Promise<boolean> {
  const { data, error } = await supabase.rpc('renew_indexing_lease', {
    p_chain: input.chain, p_path: input.path, p_owner: input.owner, p_lease_ms: input.leaseMs,
  });
  if (error) throw error;
  return data === true;
}

export async function finishIndexingRun(input: FinishIndexingRunInput): Promise<boolean> {
  const { data, error } = await supabase.rpc('finish_indexing_run', {
    p_chain: input.chain, p_path: input.path, p_owner: input.owner, p_status: input.status,
    p_error_code: input.errorCode ?? null, p_checkpoint: input.checkpoint ?? null, p_head: input.head ?? null,
    p_checked_count: input.checkedCount ?? 0, p_pending_count: input.pendingCount ?? 0,
    p_inserted_count: input.insertedCount ?? 0, p_unresolved_count: input.unresolvedCount ?? 0,
    p_gap_count: input.gapCount ?? 0,
  });
  if (error) throw error;
  return data === true;
}

/** Backend only: the API must explicitly map this to a safe public summary. */
export async function readIndexingStates(): Promise<IndexingState[]> {
  const { data, error } = await supabase.from('indexing_state').select('*').order('chain').order('path');
  if (error) throw error;
  return (data ?? []) as IndexingState[];
}
