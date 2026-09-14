import type { Chain } from '@/db/schema';
import {
  supabase,
  upsertErc8004Agents,
  upsertErc8004Feedback,
  getRegistryCursorTip,
  setRegistryCursorTip,
} from '@/db/client';
import {
  acquireIndexingLease,
  renewIndexingLease,
  finishIndexingRun,
  releaseIndexingLease,
} from '@/db/indexing-state';
import { runWithIndexingContext } from '@/db/indexing-context';
import { INDEXING_PATHS, type IndexingPath } from './indexing-health';
import { isIndexingStalled } from './indexing-exit';
import {
  executeIndexingJob,
  releaseHeldIndexingLeases,
  type IndexingJob,
  type ScanOutcome,
} from './indexing-runner';

interface Coverage {
  complete: boolean;
  head?: string;
  checkpoint?: string | null;
  checked: number;
  pending: number;
  unresolved: number;
  gaps?: number;
  reason?: string;
}
export function coverageOutcome(
  coverage: Coverage,
  insertedCount: number,
): ScanOutcome {
  const dormant = coverage.reason === 'empty_seed';
  // A throttle is only a failed RUN when it stopped us checking anything. With
  // targets checked and rows landed, one 429 among hundreds of calls is ordinary
  // backpressure — reporting it as `failed` pages on a run that did its job, and
  // that is what made keep-fresh red while ingesting 895 transactions.
  const throttled =
    coverage.reason === 'rate_limited' || coverage.reason === 'rpc_rate_limited';
  const failed =
    (throttled && coverage.checked === 0) ||
    [
      'all_absent',
      'head_behind_cursor',
      'address_failure',
      'registry_read_failure',
      'rpc_unavailable',
    ].includes(coverage.reason ?? '');
  return {
    status: dormant
      ? 'dormant'
      : failed
        ? 'failed'
        : coverage.complete &&
            coverage.unresolved === 0 &&
            coverage.pending === 0 &&
            (coverage.gaps ?? 0) === 0
          ? 'caught_up'
          : 'catching_up',
    errorCode: coverage.reason,
    checkpoint: coverage.checkpoint,
    head: coverage.head,
    checkedCount: coverage.checked,
    pendingCount: coverage.pending,
    unresolvedCount: coverage.unresolved,
    gapCount: coverage.gaps ?? 0,
    insertedCount,
  };
}
export interface JobOptions {
  limit?: number;
  backfill?: boolean;
  fromOffset?: number;
  rescanWindow?: number;
}
export function createIndexingJob(
  chain: Chain,
  path: IndexingPath,
  options: JobOptions = {},
): IndexingJob {
  const definition = INDEXING_PATHS.find(
    (p) => p.chain === chain && p.path === path,
  );
  if (!definition) throw Error('Unknown indexing path');
  return {
    ...definition,
    timeoutMs:
      path === 'registry' ? 1_200_000 : chain === 'solana' ? 600_000 : 180_000,
    run: async (signal) => {
      if (chain === 'arc-mainnet' && path === 'transfers') {
        const { runArcMainnetTransfersIndexer } = await import('@/indexer/arc-mainnet-transfers');
        const result = await runArcMainnetTransfersIndexer({ signal });
        return coverageOutcome(result.coverage, result.inserted);
      }
      if (chain === 'arc' && path === 'escrow') {
        const { runArcJobsIndexer } = await import('@/indexer/arc-jobs');
        const r = await runArcJobsIndexer({ signal });
        return coverageOutcome(
          {
            ...r.coverage,
            gaps:
              r.coverage.reason === 'head_behind_cursor'
                ? 0
                : r.coverage.unresolved,
            unresolved:
              r.coverage.reason === 'head_behind_cursor'
                ? r.coverage.unresolved
                : 0,
          },
          r.inserted,
        );
      }
      if (chain === 'arc' && path === 'transfers') {
        const { runArcTransfersIndexer } =
          await import('@/indexer/arc-transfers');
        const r = await runArcTransfersIndexer({ signal });
        return coverageOutcome(r.coverage, r.inserted);
      }
      if (chain === 'arc' && path === 'registry') {
        const { runArcRegistryRefresh } =
          await import('@/indexer/arc-registry-refresh');
        const r = await runArcRegistryRefresh({ signal });
        return coverageOutcome(r.coverage, r.agentsPersisted);
      }
      if (chain === 'stellar' && path === 'transfers') {
        const { runStellarTransfersIndexer } =
          await import('@/indexer/stellar-transfers');
        const r = await runStellarTransfersIndexer({ signal });
        return coverageOutcome(r.coverage, r.inserted);
      }
      if (chain === 'celo' && path === 'payments') {
        const { runCeloX402Indexer } = await import('@/indexer/celo-x402');
        const r = await runCeloX402Indexer({ signal });
        return coverageOutcome(r.coverage, r.inserted);
      }
      if (chain === 'celo' && path === 'registry') {
        const { getRegistryConfig } =
          await import('@/config/erc8004-registries');
        const { runIncrementalRegistryScan } =
          await import('@/indexer/erc8004-registry');
        const config = getRegistryConfig('celo');
        if (!config) throw Error('configuration_missing');
        const r = await runIncrementalRegistryScan(
          config,
          upsertErc8004Agents,
          upsertErc8004Feedback,
          (c) => getRegistryCursorTip(c as Chain),
          (c, tip) => setRegistryCursorTip(c as Chain, tip),
          { rescanWindow: options.rescanWindow ?? 100, signal },
        );
        return {
          status: r.errors ? 'failed' : 'caught_up',
          errorCode: r.errors ? 'scan_partial' : undefined,
          checkedCount: r.agentsScanned,
          insertedCount: r.agentsPersisted,
          unresolvedCount: r.errors,
          checkpoint: String(r.tip),
          head: String(r.tip),
        };
      }
      if (chain === 'stellar' && path === 'registry') {
        const { getStellarRpc } =
          await import('@/integrations/erc8004-stellar');
        const { makeStellarRegistryReader, scanStellarRegistry } =
          await import('@/indexer/stellar-registry');
        const r = await scanStellarRegistry({
          reader: makeStellarRegistryReader(getStellarRpc()),
          concurrency: 2,
          fetchRemote: true,
          signal,
        });
        const count = await upsertErc8004Agents('stellar', r.agents);
        return {
          status: r.errors.length ? 'failed' : 'caught_up',
          errorCode: r.errors.length ? 'scan_partial' : undefined,
          checkedCount: r.attempted,
          insertedCount: count,
          unresolvedCount: r.errors.length,
        };
      }
      if (chain === 'solana' && path === 'registry') {
        const { SolanaSDK } = await import('8004-solana');
        const { makeSolanaRegistryReader, scanSolanaRegistry } =
          await import('@/indexer/solana-registry');
        const { Keypair } = await import('@solana/web3.js');
        const sdk = new SolanaSDK({
          signer: Keypair.generate(),
          cluster: 'mainnet-beta',
          ...(process.env.SOLANA_RPC_URL
            ? { rpcUrl: process.env.SOLANA_RPC_URL }
            : {}),
        });
        const r = await scanSolanaRegistry({
          reader: makeSolanaRegistryReader(sdk),
          fromOffset: options.fromOffset ?? 0,
          fetchRemote: true,
          signal,
        });
        const count = await upsertErc8004Agents('solana', r.agents);
        return {
          status:
            r.errors.length || r.skippedNoAgentId
              ? 'failed'
              : options.fromOffset
                ? 'catching_up'
                : 'caught_up',
          errorCode: r.errors.length ? 'scan_partial' : undefined,
          checkedCount: r.agents.length,
          pendingCount: options.fromOffset ? options.fromOffset : 0,
          insertedCount: count,
          unresolvedCount: r.errors.length + r.skippedNoAgentId,
        };
      }
      if (chain === 'solana' && path === 'payments') {
        const { runIndexer } = await import('@/indexer/index');
        const r = await runIndexer(
          options.limit ?? (Number(process.env.INDEXER_WORKER_LIMIT) || 200),
          { backfill: options.backfill ?? false, signal },
        );
        return coverageOutcome(r.coverage, r.inserted);
      }
      throw Error('Unknown indexing path');
    },
  };
}
export async function runIndexingJob(
  chain: Chain,
  path: IndexingPath,
  options: JobOptions = {},
) {
  return runManagedIndexingTask(createIndexingJob(chain, path, options));
}
/** The state store, injectable so the lease/stall wiring is testable. */
export interface ManagedTaskStore {
  acquire: typeof acquireIndexingLease;
  renew: typeof renewIndexingLease;
  finish: typeof finishIndexingRun;
  release: typeof releaseIndexingLease;
  withContext: typeof runWithIndexingContext;
}
export async function runManagedIndexingTask(
  job: IndexingJob,
  store: Partial<ManagedTaskStore> = {},
) {
  const {
    acquire = acquireIndexingLease,
    renew = renewIndexingLease,
    finish = finishIndexingRun,
    release = releaseIndexingLease,
    withContext = runWithIndexingContext,
  } = store;
  const { chain, path } = job;
  let normalized: ScanOutcome | undefined;
  let previousGaps = 0;
  let previous: { checkpoint: string | null } | null = null;
  let stalled = false;
  const execution = await executeIndexingJob(job, {
    acquire: async (input) => {
      const state = await acquire(input);
      previousGaps = state?.gaps_count ?? 0;
      // Only a path that has finished before has a cursor worth comparing.
      previous = state?.last_finished_at ? { checkpoint: state.checkpoint } : null;
      return Boolean(state);
    },
    renew,
    release,
    finish: async (input) => {
      // Historical coverage gaps survive later successful incremental scans;
      // retriable decode failures clear when a subsequent scan actually succeeds.
      const gaps = Math.max(input.gapCount ?? 0, previousGaps);
      normalized = {
        status:
          gaps && input.status === 'caught_up' ? 'catching_up' : input.status,
        errorCode: input.errorCode ?? (gaps ? 'archive_gap' : undefined),
        checkpoint: input.checkpoint,
        head: input.head,
        checkedCount: input.checkedCount,
        pendingCount: input.pendingCount,
        insertedCount: input.insertedCount,
        unresolvedCount: input.unresolvedCount,
        gapCount: gaps,
      };
      stalled = isIndexingStalled(previous, normalized);
      return finish({
        ...normalized,
        ...{ chain, path, owner: input.owner },
        checkpoint: normalized.checkpoint ?? undefined,
        head: normalized.head ?? undefined,
      });
    },
    withContext,
  });
  if (execution.status === 'busy' || execution.status === 'lease_lost')
    return execution;
  return normalized ? { ...normalized, stalled } : execution;
}
/**
 * A container replaced mid-scan is the common way a lease is orphaned. On a
 * graceful stop we can still hand back what we hold, so the next boot's health
 * read sees the truth instead of a phantom owner. A SIGKILL runs nothing —
 * that case is covered read-side, where an expired lease is not a verdict.
 */
let shutdownHandlersInstalled = false;
function installLeaseShutdownHandlers() {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      // Registering a listener SUPPRESSES Node's default terminate. Inside a
      // `once` handler this count excludes our own, so zero means we are the
      // only thing standing between the signal and the exit — release, then
      // re-raise so the default action runs. Bounded either way: an
      // unreachable DB must not wedge a container in shutdown.
      const soleListener = process.listenerCount(signal) === 0;
      const deadline = new Promise<number>((resolve) => {
        setTimeout(() => resolve(-1), 2_000).unref?.();
      });
      void Promise.race([releaseHeldIndexingLeases(), deadline])
        .catch(() => -1)
        .then((released) => {
          if (released > 0)
            console.log(`[indexing] released ${released} lease(s) on ${signal}`);
          if (soleListener) process.kill(process.pid, signal);
        });
    });
  }
}
/** Reuse the same ownership contract from app workers, manual recovery and CI. */
export function startIndexingWorkers() {
  if (
    process.env.NEXT_PHASE === 'phase-production-build' ||
    process.env.INDEXING_WORKER_DISABLED === '1'
  )
    return;
  installLeaseShutdownHandlers();
  for (const def of INDEXING_PATHS) {
    if (
      def.chain === 'solana' &&
      def.path === 'payments' &&
      process.env.INDEXER_WORKER_DISABLED === '1'
    )
      continue;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const r = await runIndexingJob(def.chain, def.path);
        console.log(`[indexing] ${def.chain}/${def.path} status=${r.status}`);
      } catch {
        console.error(`[indexing] ${def.chain}/${def.path} state_unavailable`);
      } finally {
        running = false;
      }
    };
    const intervalMs =
      def.chain === 'solana' && def.path === 'payments'
        ? Number(process.env.INDEXER_WORKER_INTERVAL_MS) || def.intervalMs
        : def.intervalMs;
    const timer = setInterval(() => {
      void tick();
    }, intervalMs);
    timer.unref?.();
    // Small boot staggering avoids a shared DB/RPC burst after deployment.
    const boot = setTimeout(
      () => {
        void tick();
      },
      INDEXING_PATHS.indexOf(def) * 5_000,
    );
    boot.unref?.();
  }
}
/** Per-chain event time for the legacy Solana diagnostic, never an all-chain health verdict. */
export async function readLatestSolanaTransaction() {
  const { data, error } = await supabase
    .from('transactions')
    .select('timestamp')
    .eq('chain', 'solana')
    .order('timestamp', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data?.[0]?.timestamp as string | undefined) ?? null;
}
