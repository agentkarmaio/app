import { runIndexingJob } from '@/lib/indexing-jobs';
import { INDEXING_PATHS } from '@/lib/indexing-health';
import { requireEnv } from '@/lib/require-env';
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
try {
  const result = await runIndexingJob(job.chain, job.path, {
    limit: intFlag('--limit'),
    backfill: process.argv.includes('--backfill'),
    fromOffset: intFlag('--from-offset'),
  });
  console.log(JSON.stringify({ chain: job.chain, path: job.path, ...result }));
  process.exit(
    result.status === 'failed' ||
      result.status === 'lease_lost' ||
      ('gapCount' in result && (result.gapCount ?? 0) > 0) ||
      ('unresolvedCount' in result && (result.unresolvedCount ?? 0) > 0)
      ? 1
      : 0,
  );
} catch {
  console.error(`[indexing] ${job.chain}/${job.path} run_failed`);
  process.exit(1);
}
