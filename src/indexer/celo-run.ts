/**
 * CLI entrypoint: bun run src/indexer/celo-run.ts [--dry-run] [--window N] [--max-windows N]
 *
 * Scans Celo USDC/USDT/USDm Transfer events for seeded x402 facilitators/payees,
 * persists Tier-1 receipts to Supabase, and advances the block cursor.
 *
 * --dry-run prints the would-be `transactions` rows WITHOUT any DB write or
 * cursor advance — the local verification path before a real production write.
 *
 * Env:
 *   CELO_RPC_URL            — Celo RPC (optional; viem defaults to public Forno)
 *   CELO_X402_FACILITATORS  — comma-separated facilitator/payee addrs (optional)
 *   CELO_X402_START_BLOCK   — first block for the first scan (optional)
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — required for real runs
 */

import { runCeloX402Indexer } from './celo-x402';
import { celoX402FacilitatorSetWithDiscovered } from '../config/celo-x402';

function numArg(flag: string): number | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

const dryRun = process.argv.includes('--dry-run');
const windowSize = numArg('--window');
const maxWindows = numArg('--max-windows');

// Merged set: curated + env + verified self-seeded payees (celo_x402_payees).
const facilitators = await celoX402FacilitatorSetWithDiscovered();
console.log(`[celo-indexer] mode: ${dryRun ? 'DRY-RUN (no DB writes)' : 'live'}`);
console.log(`[celo-indexer] RPC: ${process.env.CELO_RPC_URL ? 'custom' : 'public Forno (rate-limited)'}`);
console.log(`[celo-indexer] facilitators+payees seeded: ${facilitators.size}`);
if (facilitators.size === 0) {
  console.log('[celo-indexer] none seeded — no-op. Seed via CELO_X402_FACILITATORS env, config, or scripts/celo-x402-discover-payees.ts.');
  process.exit(0);
}
console.log(`[celo-indexer] watching: ${[...facilitators].join(', ')}`);

const start = Date.now();

runCeloX402Indexer({ windowSize, maxWindows, dryRun })
  .then((result) => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n[celo-indexer] Done in ${elapsed}s`);
    console.log(`[celo-indexer] Fetched: ${result.fetched} | Inserted: ${result.inserted}`);
    if (dryRun && result.rows) {
      console.log(`[celo-indexer] DRY-RUN rows (${result.rows.length}):`);
      for (const r of result.rows.slice(0, 20)) {
        console.log(
          `  ${r.timestamp}  ${String(r.amount).padStart(12)}  payer ${r.wallet_address.slice(0, 10)}…` +
          `  facilitator ${r.facilitator.slice(0, 10)}…  tx ${r.tx_signature.slice(0, 16)}…`,
        );
      }
      if (result.rows.length > 20) console.log(`  …and ${result.rows.length - 20} more`);
    }
    for (const [k, v] of result.cursors) console.log(`[celo-indexer] cursor ${k} → ${v}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('[celo-indexer] Fatal error:', err);
    process.exit(1);
  });
