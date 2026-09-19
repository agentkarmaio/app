import { expect, test } from 'bun:test';
import { runArcJobsIndexer } from './arc-jobs';
import { runArcTransfersIndexer } from './arc-transfers';
import { runArcRegistryRefresh } from './arc-registry-refresh';

// Production entrypoints refuse before creating RPC clients or reading DB seeds.
// The pure historical parsers remain covered in each indexer's existing suite.
test.each([
  ['escrow', runArcJobsIndexer],
  ['transfers', runArcTransfersIndexer],
  ['registry', runArcRegistryRefresh],
] as const)('manual testnet %s ingestion is retired', async (_path, run) => {
  await expect(run()).rejects.toThrow('arc_testnet_retired');
});
