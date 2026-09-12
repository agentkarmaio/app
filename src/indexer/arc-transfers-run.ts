/**
 * CLI entrypoint: bun run src/indexer/arc-transfers-run.ts [flags]
 *
 * Reads seed-scoped plain USDC `Transfer` events on Arc Testnet and persists
 * them as Tier-1 receipts. ARC TESTNET ONLY — Arc mainnet has no live ERC-8004
 * registry, so it has no seed set (see src/config/arc-chain.ts).
 *
 * Flags:
 *   --dry-run              counting no-ops for every write; no cursor moves.
 *   --start-block <n>      DRY RUN ONLY. Sample from block n instead of the
 *                          persisted cursor, so a spot check at head does not
 *                          require walking the whole backlog first.
 *   --max-windows <n>      cap the window loop (both modes).
 *
 * Env:
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — required (seed set)
 *   ARC_RPC_URL — required by the indexer; rpc.drpc.testnet.arc.io is the only
 *                 keyless endpoint that serves historical getLogs.
 *
 */

import { runIndexerCli } from './managed-cli';
import { coverageOutcome } from '@/lib/indexing-jobs';

import type { Transaction } from '@/db/schema';
import { requireEnv } from '@/lib/require-env';
import {
  buildArcSeedSet,
  loadArcSeedRows,
  runArcTransfersIndexer,
  ARC_TRANSFER_EXCLUSIONS,
  type ArcTransfersIndexerDeps,
} from './arc-transfers';

// Fail loudly at line 1 when the DB secrets are missing. An unset GitHub
// Actions secret expands to an EMPTY STRING, and a scheduled job whose
// credentials silently vanish is the 2026-06-23 outage: green runs, zero
// writes. Even --dry-run reads the DB for the seed set, so both modes need
// these — and an empty seed makes this indexer a no-op by design, which is
// exactly the shape that would hide the failure.
requireEnv(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

const DRY_RUN = process.argv.includes('--dry-run');

function numericFlag(name: string): number | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  const raw = process.argv[i + 1];
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`[arc-transfers] ${name} needs a non-negative integer, got: ${raw}`);
    process.exit(1);
  }
  return n;
}

const startBlock = numericFlag('--start-block');
const maxWindows = numericFlag('--max-windows');

if (startBlock !== undefined && !DRY_RUN) {
  // Persisting a hand-picked start block would silently skip every block
  // between the real cursor and it — the 2026-08-10 trap, on purpose instead of
  // by accident. Sampling is a read-only activity.
  console.error('[arc-transfers] --start-block is DRY RUN ONLY (it would skip blocks the cursor still owes)');
  process.exit(1);
}

/** Counting no-ops: exercise the real read path, write nothing. */
function dryRunOverrides(sink: {
  rows: Omit<Transaction, 'id'>[];
  signals: number;
  wallets: Set<string>;
}): Partial<ArcTransfersIndexerDeps> {
  const overrides: Partial<ArcTransfersIndexerDeps> = {
    insertTransactions: async (rows) => { sink.rows.push(...rows); return rows.length; },
    insertSignalEvents: async (s) => { sink.signals += s.length; return s.length; },
    ensureWallets: async (addresses) => { for (const a of addresses) sink.wallets.add(a); },
    upsertCursor: async () => { /* never advance a cursor in a dry run */ },
  };
  if (startBlock !== undefined) {
    overrides.getCursor = async () => ({
      last_signature: String(startBlock - 1),
      last_slot: startBlock - 1,
    });
  }
  return overrides;
}

const sink = { rows: [] as Omit<Transaction, 'id'>[], signals: 0, wallets: new Set<string>() };

console.log(`[arc-transfers] Network: arc testnet`);
console.log(`[arc-transfers] Mode: ${DRY_RUN ? 'DRY RUN — no writes' : 'live'}`);

// Report the seed BEFORE the run, and report what the exclusions removed —
// the zero address alone matched 495 + 952 transfers in one 10k-block window
// at head, against 6 for the whole clean seed. A silent exclusion is the one
// number a reader most needs to see.
const seedRows = await loadArcSeedRows();
const unfiltered = buildArcSeedSet({ ...seedRows, exclusions: new Set<string>() });
const seed = buildArcSeedSet(seedRows);
const dropped = [...unfiltered].filter((a) => !seed.has(a));

console.log(`[arc-transfers] Seed: ${seed.size} addresses `
  + `(registry rows ${seedRows.registryRows.length}, marker wallets ${seedRows.walletRows.length})`);
console.log(`[arc-transfers] Excluded from seed: ${dropped.length}`
  + (dropped.length > 0 ? ` → ${dropped.join(', ')}` : ''));
console.log(`[arc-transfers] Exclusion set (also checked per-transfer): ${[...ARC_TRANSFER_EXCLUSIONS].join(', ')}`);
if (startBlock !== undefined) console.log(`[arc-transfers] Sampling from block ${startBlock}`);

const start = Date.now();

runIndexerCli({
  chain: 'arc', path: 'transfers', dryRun: DRY_RUN,
  run: async (signal) => runArcTransfersIndexer({ signal, maxWindows, ...(DRY_RUN ? { overrides: dryRunOverrides(sink) } : {}) }),
  summarize: (result) => coverageOutcome(result.coverage, result.inserted),
})
  .then(({ result, status, exitCode, errorCode }) => {
    if (!result) {
      console.log(`[arc-transfers] ${status}${errorCode ? ` (${errorCode})` : ''} — no scan result`);
      process.exit(exitCode);
    }
    console.log(`[arc-transfers] managed status: ${status}`);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n[arc-transfers] Done in ${elapsed}s`);
    console.log(`[arc-transfers] Fetched: ${result.fetched} | Inserted: ${result.inserted}`);
    for (const [k, v] of result.cursors) console.log(`[arc-transfers] cursor ${k} → ${v}`);

    if (DRY_RUN) {
      const distinctTx = new Set(sink.rows.map((r) => r.tx_signature));
      const withCounterparty = sink.rows.filter((r) => r.counterparty).length;
      console.log(`\n[arc-transfers] DRY RUN — nothing was written.`);
      console.log(`[arc-transfers]   matched rows        : ${sink.rows.length}`);
      console.log(`[arc-transfers]   distinct tx hashes  : ${distinctTx.size}`);
      // Must be N/N. reciprocity.ts reads inbound as `WHERE counterparty = W`;
      // a null-counterparty row is invisible there and makes a wallet look MORE
      // independent than it is.
      console.log(`[arc-transfers]   rows w/ counterparty: ${withCounterparty}/${sink.rows.length}`);
      console.log(`[arc-transfers]   wallets touched     : ${sink.wallets.size}`);
      console.log(`[arc-transfers]   of those, NOT seeded: ${[...sink.wallets].filter((w) => !seed.has(w)).length}`);
      console.log(`[arc-transfers]   signal events       : ${sink.signals}`);

      if (withCounterparty !== sink.rows.length) {
        console.error('[arc-transfers] A row is missing its counterparty — refusing to report success.');
        process.exit(1);
      }
    }
    process.exit(exitCode);
  })
  .catch((err) => {
    console.error('[arc-transfers] Fatal error:', err);
    process.exit(1);
  });
