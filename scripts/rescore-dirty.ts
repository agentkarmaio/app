import { drainOnce, RESCORE_DEFAULT_BATCH_SIZE } from '../src/scripts/rescore-dirty';

async function main() {
  const batchSize = Number(process.argv[2]) || Number(process.env.RESCORE_BATCH_SIZE) || RESCORE_DEFAULT_BATCH_SIZE;
  console.log(`[rescore] batch=${batchSize}`);
  const result = await drainOnce(batchSize);
  console.log(`[rescore] claimed=${result.claimed} scored=${result.scored} skipped=${result.skipped} errors=${result.errors.length} remaining=${result.remaining} elapsed=${result.elapsedMs}ms`);
  if (result.errors.length > 0) {
    const sample = result.errors.slice(0, 5);
    console.log(`[rescore] first errors: ${JSON.stringify(sample)}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[rescore] fatal:', err);
  process.exit(1);
});
