/**
 * CLI entrypoint: bun run src/indexer/celo-run.ts [--dry-run] [--window N] [--max-windows N]
 *
 * Scans Celo x402 settlements: Transfer events for seeded facilitators/payees,
 * plus relayer-submitted EIP-3009 settlements (quarantined, see celo-x402-relayer.ts),
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

import { runIndexerCli } from './managed-cli';
import { coverageOutcome } from '@/lib/indexing-jobs';

import { requireEnv } from '../lib/require-env';
import { runCeloX402Indexer } from './celo-x402';
import type { CeloX402PromotionResult } from './celo-x402-promotion';
import { celoX402FacilitatorSetWithDiscovered, celoX402RelayerSet } from '../config/celo-x402';

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
requireEnv(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
const facilitators = await celoX402FacilitatorSetWithDiscovered();
console.log(`[celo-indexer] mode: ${dryRun ? 'DRY-RUN (no DB writes)' : 'live'}`);
console.log(`[celo-indexer] RPC: ${process.env.CELO_RPC_URL ? 'custom' : 'public Forno (rate-limited)'}`);
console.log(`[celo-indexer] facilitators+payees seeded: ${facilitators.size}`);
if (facilitators.size === 0) {
  console.log('[celo-indexer] none seeded — no-op. Seed via CELO_X402_FACILITATORS env, config, or scripts/celo-x402-discover-payees.ts.');
}
console.log(`[celo-indexer] watching: ${[...facilitators].join(', ')}`);
console.log(`[celo-indexer] relayers (quarantined → celo_x402_settlements): ${[...celoX402RelayerSet()].join(', ')}`);

const start = Date.now();

function printPromotion(p: CeloX402PromotionResult | { error: string }, dry: boolean): void {
  const tag = dry ? 'DRY-RUN promotion' : 'promotion';
  if ('error' in p) {
    console.error(`[celo-indexer] ${tag} FAILED: ${p.error}`);
    return;
  }
  if (!p.slice) {
    console.log(`[celo-indexer] ${tag}: nothing due`);
    return;
  }
  console.log(
    `[celo-indexer] ${tag} slice (${p.slice.from ?? 'start'}, ${p.slice.to}]: decided ${p.decided}` +
    ` | promote ${p.promoted.length} (inserted ${p.inserted}) | quarantine ${p.quarantined.length}`,
  );
  for (const c of p.clusters) {
    console.log(
      `  cluster ${c.members.length} wallets  closure ${c.closure.toFixed(3)}  ${c.count} payments  $${c.value.toFixed(2)}` +
      `  loop ${c.sampleCycle.map((a) => a.slice(0, 10)).join(' → ')} → ${c.sampleCycle[0].slice(0, 10)}`,
    );
  }
  for (const l of p.lateFlagged) {
    console.warn(`  LATE FLAG ${l.payer} → ${l.payee}: ${l.promoted} promoted rows now ${l.reasons.join('+')}`);
  }
  if (!dry) return;
  for (const t of p.promoted.slice(0, 20)) {
    console.log(`  promote  ${t.timestamp}  ${String(t.amount).padStart(10)}  ${t.wallet_address.slice(0, 10)}… → ${t.counterparty?.slice(0, 10)}…`);
  }
  for (const q of p.quarantined.slice(0, 20)) {
    console.log(`  hold     ${q.row.block_time}  ${String(q.row.amount).padStart(10)}  ${q.row.payer.slice(0, 10)}… → ${q.row.payee.slice(0, 10)}…  ${q.reasons.join('+')}`);
  }
}

runIndexerCli({
  chain: 'celo', path: 'payments', dryRun: dryRun,
  run: async (signal) => runCeloX402Indexer({ windowSize, maxWindows, dryRun, signal }),
  summarize: (result) => coverageOutcome(result.coverage, result.inserted),
})
  .then(({ result, status, exitCode, errorCode }) => {
    if (!result) {
      console.log(`[indexer] ${status}${errorCode ? ` (${errorCode})` : ''} — no scan result`);
      process.exit(exitCode);
    }
    console.log(`[indexer] managed status: ${status}`);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n[celo-indexer] Done in ${elapsed}s`);
    console.log(`[celo-indexer] Fetched: ${result.fetched} | Inserted: ${result.inserted}`);
    console.log(`[celo-indexer] coverage: ${JSON.stringify(result.coverage)}`);
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
    if (dryRun && result.settlements) {
      console.log(`[celo-indexer] DRY-RUN relayer settlements (${result.settlements.length}):`);
      for (const s of result.settlements.slice(0, 20)) {
        console.log(`  ${s.blockTime}  ${String(s.value).padStart(10)} ${s.symbol}  ${s.payer.slice(0, 10)}… → ${s.payee.slice(0, 10)}…`);
      }
      if (result.settlements.length > 20) console.log(`  …and ${result.settlements.length - 20} more`);
    }
    printPromotion(result.promotion, dryRun);
    for (const [k, v] of result.cursors) console.log(`[celo-indexer] cursor ${k} → ${v}`);
    process.exit(exitCode);
  })
  .catch((err) => {
    console.error('[celo-indexer] Fatal error:', err);
    process.exit(1);
  });
