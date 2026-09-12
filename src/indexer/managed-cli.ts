import type { Chain } from '@/db/schema';
import type { IndexingPath } from '@/lib/indexing-health';
import type { IndexingJob, ScanOutcome } from '@/lib/indexing-runner';

type ManagedStatus = ScanOutcome['status'] | 'busy' | 'lease_lost';
export interface ManagedCliDependencies {
  createJob: (chain: Chain, path: IndexingPath) => IndexingJob;
  execute: (
    job: IndexingJob,
  ) => Promise<{
    status: ManagedStatus;
    unresolvedCount?: number;
    gapCount?: number;
    errorCode?: string;
  }>;
}
export interface ManagedCliResult<T> {
  result?: T;
  status: ManagedStatus | 'dry_run';
  exitCode: 0 | 1 | 2;
  errorCode?: string;
}

/** Preserve CLI flags/results while sharing the application's write lease. */
export async function runIndexerCli<T>(
  options: {
    chain: Chain;
    path: IndexingPath;
    dryRun?: boolean;
    run: (signal?: AbortSignal) => Promise<T>;
    summarize: (result: T) => ScanOutcome;
  },
  loadManaged: () => Promise<ManagedCliDependencies> = async () => {
    const { createIndexingJob, runManagedIndexingTask } =
      await import('@/lib/indexing-jobs');
    return { createJob: createIndexingJob, execute: runManagedIndexingTask };
  },
): Promise<ManagedCliResult<T>> {
  const exitCode = (outcome: {
    status: ManagedStatus;
    unresolvedCount?: number;
    gapCount?: number;
  }): 0 | 1 | 2 =>
    outcome.status === 'busy'
      ? 2
      : outcome.status === 'failed' ||
          outcome.status === 'lease_lost' ||
          (outcome.unresolvedCount ?? 0) > 0 ||
          (outcome.gapCount ?? 0) > 0
        ? 1
        : 0;
  // No lease acquisition, run completion, or health writes in a dry run.
  if (options.dryRun) {
    const result = await options.run();
    return {
      status: 'dry_run',
      exitCode: exitCode(options.summarize(result)),
      result,
    };
  }
  const managed = await loadManaged();
  let captured: T | undefined;
  const outcome = await managed.execute({
    ...managed.createJob(options.chain, options.path),
    run: async (signal) => {
      captured = await options.run(signal);
      signal.throwIfAborted();
      return options.summarize(captured);
    },
  });
  return {
    status: outcome.status,
    exitCode: exitCode(outcome),
    ...(captured === undefined ? {} : { result: captured }),
    ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
  };
}
