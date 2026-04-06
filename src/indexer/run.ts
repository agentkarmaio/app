/**
 * CLI entrypoint: bun run src/indexer/run.ts
 *
 * Fetches x402 transactions from all facilitators via Helius RPC,
 * persists to Supabase, and calculates karma scores.
 */

import { runIndexer } from './index';

const limit = parseInt(process.argv[2] ?? '50', 10);

console.log(`[indexer] Fetching up to ${limit} transactions per facilitator...`);
console.log(`[indexer] RPC: ${process.env.HELIUS_RPC_URL ? 'Helius' : process.env.SOLANA_RPC_URL ? 'custom' : 'public mainnet (rate-limited!)'}`);


const start = Date.now();

runIndexer(limit)
  .then((result) => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n[indexer] Done in ${elapsed}s`);
    console.log(`[indexer] Fetched: ${result.fetched} | Inserted: ${result.inserted} | Scored: ${result.scored}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('[indexer] Fatal error:', err);
    process.exit(1);
  });
