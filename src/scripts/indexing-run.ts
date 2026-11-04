import { runIndexingJob } from '@/lib/indexing-jobs';
import { indexingErrorCode } from '@/lib/indexing-runner';
import { shouldPageIndexingOutcome } from '@/lib/indexing-exit';
import { INDEXING_PATHS } from '@/lib/indexing-health';
import { requireEnv } from '@/lib/require-env';
import { appendFileSync } from 'fs';
requireEnv(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
const [chain, path] = process.argv.slice(2);
const job = INDEXING_PATHS.find((p) => p.chain === chain && p.path === path);
if (!job)
  throw Error(
    'Usage: bun src/scripts/indexing-run.ts <chain> <payments|escrow|transfers|registry>',
  );
function intFlag(name: string) {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const s = process.argv[i + 1];
  if (!/^\d+$/.test(s ?? '')) throw Error('Invalid numeric argument');
  return Number(s);
}
/** Hands the workflow's page the cause, so triage does not start in the logs. */
function publishPageReason(reason: string) {
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `page_reason=${reason.replace(/\s+/g, ' ')}\n`);
}
try {
  const result = await runIndexingJob(job.chain, job.path, {
    limit: intFlag('--limit'),
    backfill: process.argv.includes('--backfill'),
    fromOffset: intFlag('--from-offset'),
  });
  console.log(JSON.stringify({ chain: job.chain, path: job.path, ...result }));
  const page = shouldPageIndexingOutcome(result);
  if (page) {
    const detail = 'errorDetail' in result && result.errorDetail ? ` (${result.errorDetail})` : '';
    publishPageReason(`${result.status}: ${result.errorCode ?? 'stalled'}${detail}`);
  }
  process.exit(page ? 1 : 0);
} catch (error) {
  // Name the cause: a bare run_failed left the 2026-09-28 page undiagnosable.
  const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
  console.error(`[indexing] ${job.chain}/${job.path} run_failed (${indexingErrorCode(error)}): ${detail}`);
  publishPageReason(`run_failed: ${indexingErrorCode(error)}`);
  process.exit(1);
}
