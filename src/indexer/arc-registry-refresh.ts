/**
 * Refresh Arc's approved registry membership. Never discover new IDs: the
 * testnet has hundreds of thousands of synthetic registrations, and widening
 * this mirror would also widen the transfer indexer's seed scope.
 */
import { getRegistryConfig } from '@/config/erc8004-registries';
import {
  getCursor, upsertCursor, supabase,
  upsertErc8004Agents, upsertErc8004Feedback,
} from '@/db/client';
import { runRegistryScan, type RegistryScanResult } from './erc8004-registry';

export const ARC_REGISTRY_REFRESH_CURSOR_KEY = 'arc:registry-refresh';
export const ARC_REGISTRY_MEMBERSHIP_CAP = 2_752;

export interface ArcRegistryRefreshDeps {
  signal?: AbortSignal;
  loadKnownIds: () => Promise<number[]>;
  readCheckpoint: () => Promise<number>;
  writeCheckpoint: (lastId: number) => Promise<void>;
  scanIds: (ids: number[]) => Promise<RegistryScanResult>;
  maxIds?: number;
  batchSize?: number;
  timeBudgetMs?: number;
  now?: () => number;
}

export interface ArcRegistryRefreshResult extends RegistryScanResult {
  coverage: {
    complete: boolean;
    head?: string;
    checkpoint?: string | null;
    checked: number;
    pending: number;
    unresolved: number;
    reason?: string;
  };
}

/** Bounded contiguous progress through the sorted eligible IDs, not chain IDs. */
export async function arcRegistryRefresh(deps: ArcRegistryRefreshDeps): Promise<ArcRegistryRefreshResult> {
  deps.signal?.throwIfAborted();
  const ids = [...new Set(await deps.loadKnownIds())].sort((a, b) => a - b);
  deps.signal?.throwIfAborted();
  if (ids.length > ARC_REGISTRY_MEMBERSHIP_CAP) {
    throw new Error(`Arc registry membership exceeds approved ${ARC_REGISTRY_MEMBERSHIP_CAP} IDs`);
  }
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error('Invalid Arc registry member ID');
  const maxIds = deps.maxIds ?? 200;
  const batchSize = deps.batchSize ?? 40;
  const timeBudgetMs = deps.timeBudgetMs ?? 120_000;
  if (!Number.isSafeInteger(maxIds) || maxIds < 1 || !Number.isSafeInteger(batchSize) || batchSize < 1
    || !Number.isFinite(timeBudgetMs) || timeBudgetMs < 0) throw new Error('Invalid Arc registry refresh bounds');
  const now = deps.now ?? Date.now;
  const deadline = now() + timeBudgetMs;
  let checkpoint = await deps.readCheckpoint();
  deps.signal?.throwIfAborted();
  if (!Number.isSafeInteger(checkpoint) || checkpoint < 0) throw new Error('Invalid Arc registry refresh checkpoint');
  const head = ids.at(-1) ?? 0;
  // A completed rotation starts at the first known ID. A removed last ID does
  // not strand the scanner beyond the current membership.
  if (checkpoint >= head) checkpoint = 0;
  const remaining = ids.filter((id) => id > checkpoint);
  const result: ArcRegistryRefreshResult = {
    chain: 'arc', tip: head, agentsScanned: 0, agentsPersisted: 0,
    feedbackScanned: 0, feedbackPersisted: 0, errors: 0,
    coverage: { complete: false, head: String(head), checkpoint: String(checkpoint), checked: 0, pending: remaining.length, unresolved: 0 },
  };
  if (ids.length === 0) {
    result.coverage.reason = 'empty_seed';
    return result;
  }
  let committed = 0;
  while (committed < remaining.length && committed < maxIds) {
    deps.signal?.throwIfAborted();
    if (now() >= deadline) { result.coverage.reason = 'time_budget'; break; }
    const batch = remaining.slice(committed, Math.min(committed + batchSize, maxIds));
    const scanned = await deps.scanIds(batch);
    deps.signal?.throwIfAborted();
    result.coverage.checked += batch.length;
    result.agentsScanned += scanned.agentsScanned;
    result.agentsPersisted += scanned.agentsPersisted;
    result.feedbackScanned += scanned.feedbackScanned;
    result.feedbackPersisted += scanned.feedbackPersisted;
    result.errors += scanned.errors;
    if (scanned.errors > 0) {
      result.coverage.unresolved += scanned.errors;
      result.coverage.reason = 'registry_read_failure';
      break;
    }
    checkpoint = batch[batch.length - 1];
    // Persist only a fully processed batch. An interrupted run repeats at most
    // this batch, whose identity and feedback upserts are idempotent.
    await deps.writeCheckpoint(checkpoint);
    deps.signal?.throwIfAborted();
    committed += batch.length;
    result.coverage.checkpoint = String(checkpoint);
  }
  result.coverage.pending = remaining.length - committed;
  result.coverage.complete = result.coverage.pending === 0 && result.errors === 0;
  if (result.coverage.complete) {
    await deps.writeCheckpoint(0);
  } else if (!result.coverage.reason) result.coverage.reason = 'batch_limit';
  return result;
}

/** Read the exact capped population, in pages below PostgREST's row ceiling. */
async function loadKnownArcIds(signal?: AbortSignal): Promise<number[]> {
  const ids: number[] = [];
  for (let offset = 0; offset <= ARC_REGISTRY_MEMBERSHIP_CAP; offset += 500) {
    signal?.throwIfAborted();
    const { data, error } = await supabase.from('erc8004_agents')
      .select('agent_id').eq('chain', 'arc').order('agent_id', { ascending: true })
      .range(offset, offset + 499);
    signal?.throwIfAborted();
    if (error) throw error;
    const rows = data ?? [];
    ids.push(...rows.map((row) => Number(row.agent_id)));
    if (rows.length < 500) break;
  }
  return ids;
}

/** Production wrapper. The existing membership is the sole eligibility source. */
export async function runArcRegistryRefresh(opts: {
  signal?: AbortSignal;
  maxIds?: number;
  batchSize?: number;
  timeBudgetMs?: number;
} = {}): Promise<ArcRegistryRefreshResult> {
  const config = getRegistryConfig('arc');
  if (!config) throw new Error('Arc registry config missing');
  return arcRegistryRefresh({
    ...opts,
    loadKnownIds: () => loadKnownArcIds(opts.signal),
    readCheckpoint: async () => (await getCursor(ARC_REGISTRY_REFRESH_CURSOR_KEY, 'arc'))?.last_slot ?? 0,
    writeCheckpoint: (lastId) => upsertCursor(ARC_REGISTRY_REFRESH_CURSOR_KEY, String(lastId), lastId, 'arc'),
    scanIds: (agentIds) => runRegistryScan(config, upsertErc8004Agents, upsertErc8004Feedback, {
      agentIds, signal: opts.signal,
      identityBatch: opts.batchSize ?? 40,
      feedbackBatch: opts.batchSize ?? 40,
      fetchRemote: true,
      remoteConcurrency: 4,
    }),
  });
}
