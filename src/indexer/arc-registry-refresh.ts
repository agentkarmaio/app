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
import { runRegistryScan, type RegistryScanResult, type RegistryFailedMember, type RegistryFailureStage } from './erc8004-registry';

/** Read-only conversion source; queued old workers may still write this key. */
export const ARC_REGISTRY_REFRESH_CURSOR_KEY = 'arc:registry-refresh';
export const ARC_REGISTRY_REFRESH_STATE_CURSOR_KEY = 'arc:registry-refresh:v2';
export const ARC_REGISTRY_MEMBERSHIP_CAP = 2_752;

export interface ArcRegistryRefreshState {
  version: 1;
  position: number;
  retryAfter: number;
  retryNext: boolean;
  failures: RegistryFailedMember[];
  /** Absent on legacy cursors; first conversion conservatively repeats scope. */
  membership?: number[];
}

const STAGES: RegistryFailureStage[] = ['identity', 'registration', 'feedback', 'unknown'];
const isPosition = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function validateState(value: unknown): ArcRegistryRefreshState {
  const state = value as ArcRegistryRefreshState | null;
  if (!state || state.version !== 1 || !isPosition(state.position) || !isPosition(state.retryAfter)
    || typeof state.retryNext !== 'boolean' || !Array.isArray(state.failures)
    || state.failures.length > ARC_REGISTRY_MEMBERSHIP_CAP) throw Error('Invalid Arc registry refresh state');
  const seen = new Set<number>();
  for (const member of state.failures) {
    if (!member || !isPosition(member.agentId) || member.agentId < 1 || seen.has(member.agentId)
      || !Array.isArray(member.stages) || member.stages.length === 0
      || member.stages.some(stage => !STAGES.includes(stage))) throw Error('Invalid Arc registry refresh failure');
    seen.add(member.agentId);
  }
  if (state.membership !== undefined && (!Array.isArray(state.membership)
    || state.membership.length > ARC_REGISTRY_MEMBERSHIP_CAP
    || state.membership.some((id, index) => !isPosition(id) || id < 1 || (index > 0 && id <= state.membership![index - 1])))) {
    throw Error('Invalid Arc registry refresh membership');
  }
  return structuredClone(state);
}

/** Unknown or corrupt state must never silently discard unresolved members. */
export function parseArcRegistryRefreshState(signature: string | null, slot: number | null): ArcRegistryRefreshState {
  if (signature !== null && !/^\d+$/.test(signature)) {
    const state = validateState(JSON.parse(signature));
    if (slot !== state.position) throw Error('Arc registry refresh position mismatch');
    return state;
  }
  const position = slot ?? (signature === null ? 0 : Number(signature));
  if (!isPosition(position) || (signature !== null && Number(signature) !== position)) {
    throw Error('Invalid Arc registry refresh checkpoint');
  }
  return { version: 1, position, retryAfter: 0, retryNext: false, failures: [] };
}

export interface ArcRegistryRefreshDeps {
  signal?: AbortSignal;
  loadKnownIds: () => Promise<number[]>;
  readCheckpoint: () => Promise<number | ArcRegistryRefreshState>;
  /** Scheduling and failures must be committed in one atomic cursor upsert. */
  writeCheckpoint: (lastId: number, state: ArcRegistryRefreshState) => Promise<void>;
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

/** Scheduling advances independently of an atomically persisted failure ledger. */
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
  const saved = await deps.readCheckpoint();
  deps.signal?.throwIfAborted();
  let state = typeof saved === 'number' ? parseArcRegistryRefreshState(String(saved), saved) : validateState(saved);
  const head = ids.at(-1) ?? 0;
  // Retain failures across every rotation, including removed membership. Removed
  // IDs cannot widen the RPC population and cannot be silently declared repaired.
  if (!state.membership || state.membership.length !== ids.length
    || ids.some((id, index) => id !== state.membership![index]) || state.position >= head) state.position = 0;
  state.membership = ids;
  const remaining = ids.filter(id => id > state.position);
  const eligible = new Set(ids);
  const retryIds = state.failures.map(member => member.agentId).filter(id => eligible.has(id)).sort((a, b) => a - b);
  const retries = [...retryIds.filter(id => id > state.retryAfter), ...retryIds.filter(id => id <= state.retryAfter)];
  let retryBudget = retries.length ? Math.min(retries.length, Math.ceil(maxIds / 4)) : 0;
  if (maxIds === 1 && !state.retryNext) retryBudget = 0;
  let freshBudget = maxIds - retryBudget;
  let freshOffset = 0;
  let retryOffset = 0;
  const result: ArcRegistryRefreshResult = {
    chain: 'arc', tip: head, agentsScanned: 0, agentsPersisted: 0,
    feedbackScanned: 0, feedbackPersisted: 0, errors: 0,
    coverage: { complete: false, head: String(head), checkpoint: String(state.position), checked: 0,
      pending: remaining.length, unresolved: state.failures.length },
  };
  if (ids.length === 0) {
    result.failedMembers = state.failures;
    result.coverage.reason = 'empty_seed';
    return result;
  }

  while ((freshBudget > 0 && freshOffset < remaining.length) || (retryBudget > 0 && retryOffset < retries.length)) {
    deps.signal?.throwIfAborted();
    if (now() >= deadline) { result.coverage.reason = 'time_budget'; break; }
    const canRetry = retryBudget > 0 && retryOffset < retries.length;
    const canFresh = freshBudget > 0 && freshOffset < remaining.length;
    const retry = canRetry && (state.retryNext || !canFresh);
    const batch = retry ? retries.slice(retryOffset, retryOffset + Math.min(batchSize, retryBudget))
      : remaining.slice(freshOffset, freshOffset + Math.min(batchSize, freshBudget));
    const scanned = await deps.scanIds(batch);
    deps.signal?.throwIfAborted();
    result.coverage.checked += batch.length;
    result.agentsScanned += scanned.agentsScanned;
    result.agentsPersisted += scanned.agentsPersisted;
    result.feedbackScanned += scanned.feedbackScanned;
    result.feedbackPersisted += scanned.feedbackPersisted;
    result.errors += scanned.errors;

    const failures = new Map(state.failures.map(member => [member.agentId, new Set(member.stages)]));
    const details = scanned.failedMembers;
    const exhaustive = Array.isArray(details) && details.every(member => member && batch.includes(member.agentId)
      && Array.isArray(member.stages) && member.stages.length > 0 && member.stages.every(stage => STAGES.includes(stage)))
      && (scanned.errors === 0 || details.length > 0);
    if (exhaustive) {
      const failedIds = new Set(details.map(member => member.agentId));
      for (const id of batch) if (!failedIds.has(id)) failures.delete(id);
      for (const member of details) {
        const stages = failures.get(member.agentId) ?? new Set<RegistryFailureStage>();
        member.stages.forEach(stage => stages.add(stage));
        failures.set(member.agentId, stages);
      }
    } else if (scanned.errors > 0 || details !== undefined) {
      // A legacy/partial error summary cannot identify successful members. Keep
      // every candidate, together with any earlier known failing stages.
      for (const id of batch) {
        const stages = failures.get(id) ?? new Set<RegistryFailureStage>();
        stages.add('unknown');
        failures.set(id, stages);
      }
    }
    // Missing details with zero errors also cannot clear a previous failure.
    const next = validateState({ ...state,
      position: retry ? state.position : batch[batch.length - 1],
      retryAfter: retry ? batch[batch.length - 1] : state.retryAfter,
      // Persist the other phase's priority: one slow batch cannot starve it on
      // every run, even when the deadline expires before a second batch starts.
      retryNext: !retry,
      failures: [...failures].sort(([a], [b]) => a - b).map(([agentId, stages]) => ({
        agentId, stages: STAGES.filter(stage => stages.has(stage)),
      })),
    });
    await deps.writeCheckpoint(next.position, next);
    deps.signal?.throwIfAborted();
    state = next;
    if (retry) { retryOffset += batch.length; retryBudget -= batch.length; }
    else { freshOffset += batch.length; freshBudget -= batch.length; }
    result.coverage.checkpoint = String(state.position);
  }
  result.failedMembers = state.failures;
  result.coverage.pending = remaining.length - freshOffset;
  result.coverage.unresolved = state.failures.length;
  result.coverage.complete = result.coverage.pending === 0 && state.failures.length === 0;
  if (state.failures.length > 0) result.coverage.reason = 'registry_read_failure';
  else if (!result.coverage.complete && !result.coverage.reason) result.coverage.reason = 'batch_limit';
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

export async function readArcRegistryRefreshCheckpoint(signal?: AbortSignal): Promise<ArcRegistryRefreshState> {
  signal?.throwIfAborted();
  const current = await getCursor(ARC_REGISTRY_REFRESH_STATE_CURSOR_KEY, 'arc');
  signal?.throwIfAborted();
  // A present but malformed new state fails closed; legacy progress cannot
  // replace its failure ledger, including after a rollback/queued old CI run.
  if (current) {
    if (/^\d+$/.test(current.last_signature)) throw Error('Invalid Arc registry refresh state');
    return parseArcRegistryRefreshState(current.last_signature, current.last_slot);
  }
  const cursor = await getCursor(ARC_REGISTRY_REFRESH_CURSOR_KEY, 'arc');
  signal?.throwIfAborted();
  return parseArcRegistryRefreshState(cursor?.last_signature ?? null, cursor?.last_slot ?? null);
}

export function writeArcRegistryRefreshCheckpoint(lastId: number, state: ArcRegistryRefreshState): Promise<void> {
  return upsertCursor(ARC_REGISTRY_REFRESH_STATE_CURSOR_KEY, JSON.stringify(state), lastId, 'arc');
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
    readCheckpoint: () => readArcRegistryRefreshCheckpoint(opts.signal),
    writeCheckpoint: writeArcRegistryRefreshCheckpoint,
    scanIds: (agentIds) => runRegistryScan(config, upsertErc8004Agents, upsertErc8004Feedback, {
      agentIds, signal: opts.signal,
      identityBatch: opts.batchSize ?? 40,
      feedbackBatch: opts.batchSize ?? 40,
      fetchRemote: true,
      remoteConcurrency: 4,
    }),
  });
}
