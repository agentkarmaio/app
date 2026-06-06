/**
 * CLI entrypoint: bun run src/indexer/stellar-run.ts [--testnet]
 *
 * Reads Stellar USDC SAC transfer events via Soroban RPC, attributes x402/MPP
 * receipts, persists to Supabase, and advances the ledger cursor.
 *
 * Env:
 *   STELLAR_RPC_URL      — Soroban RPC endpoint (required)
 *   STELLAR_HORIZON_URL  — Horizon endpoint for backfill (optional)
 */

import { runStellarIndexer } from './stellar-x402';

const network = process.argv.includes('--testnet') ? 'testnet' : 'pubnet';

console.log(`[stellar-indexer] Network: ${network}`);
console.log(`[stellar-indexer] RPC: ${process.env.STELLAR_RPC_URL ? 'set' : 'MISSING — will throw'}`);

const start = Date.now();

runStellarIndexer({ network })
  .then((result) => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n[stellar-indexer] Done in ${elapsed}s`);
    console.log(`[stellar-indexer] Fetched: ${result.fetched} | Inserted: ${result.inserted}`);
    for (const [k, v] of result.cursors) console.log(`[stellar-indexer] cursor ${k} → ${v}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('[stellar-indexer] Fatal error:', err);
    process.exit(1);
  });
