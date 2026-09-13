/**
 * CLI entrypoint: bun run src/indexer/stellar-transfers-run.ts [--dry-run]
 *
 * Walks each seeded Stellar account's Horizon payment feed and persists
 * issuer-pinned USDC transfers as Tier-1 receipts. MAINNET ONLY — there is no
 * --testnet flag, deliberately (see the spec's "Mainnet only" section).
 *
 * --dry-run swaps in counting no-ops for every write, so the reported match
 * count comes from the real seed set, parser and filters without touching the
 * database. Nothing is inserted and no cursor moves.
 *
 * Env:
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — required (seed set)
 *   STELLAR_HORIZON_URL — optional; defaults to https://horizon.stellar.org
 *
 */

import { runIndexerCli } from './managed-cli';
import { coverageOutcome } from '@/lib/indexing-jobs';

import type { Transaction } from '@/db/schema';
import { requireEnv } from '@/lib/require-env';
import {
  runStellarTransfersIndexer,
  type StellarTransfersDeps,
} from './stellar-transfers';

// Fail loudly at line 1 when the DB secrets are missing. An unset GitHub
// Actions secret expands to an EMPTY STRING, and a scheduled job whose
// credentials silently vanish is the 2026-06-23 outage: green runs, zero writes.
// Even --dry-run reads the DB for the seed set, so both modes need these.
requireEnv(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

const DRY_RUN = process.argv.includes('--dry-run');

/** Counting no-ops: exercise the real read path, write nothing. */
function dryRunOverrides(sink: {
  rows: Omit<Transaction, 'id'>[];
  signals: number;
  wallets: Set<string>;
}): Partial<StellarTransfersDeps> {
  return {
    insertTransactions: async (rows) => { sink.rows.push(...rows); return rows.length; },
    insertSignalEvents: async (s) => { sink.signals += s.length; return s.length; },
    ensureWallets: async (addresses) => { for (const a of addresses) sink.wallets.add(a); },
    upsertCursor: async () => { /* never advance a cursor in a dry run */ },
    writeTargetCheckpoint: async () => { /* no scheduling writes in a dry run */ },
  };
}

const sink = { rows: [] as Omit<Transaction, 'id'>[], signals: 0, wallets: new Set<string>() };

console.log(`[stellar-transfers] Network: pubnet (mainnet only)`);
console.log(`[stellar-transfers] Mode: ${DRY_RUN ? 'DRY RUN — no writes' : 'live'}`);

const start = Date.now();

runIndexerCli({
  chain: 'stellar', path: 'transfers', dryRun: DRY_RUN,
  run: async (signal) => runStellarTransfersIndexer({ signal, ...(DRY_RUN ? { overrides: dryRunOverrides(sink) } : {}) }),
  summarize: (result) => coverageOutcome(result.coverage, result.inserted),
})
  .then(({ result, status, exitCode, errorCode }) => {
    if (!result) {
      console.log(`[indexer] ${status}${errorCode ? ` (${errorCode})` : ''} — no scan result`);
      process.exit(exitCode);
    }
    console.log(`[indexer] managed status: ${status}`);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n[stellar-transfers] Done in ${elapsed}s`);
    console.log(`[stellar-transfers] Fetched: ${result.fetched} | Inserted: ${result.inserted}`);

    console.log(`[stellar-transfers] coverage: ${JSON.stringify(result.coverage)}`);
    if (result.absent.length > 0) {
      // Expected steady state, not an error: a registry agent can reference an
      // account never funded on mainnet (2026-08-26 incident).
      console.log(`[stellar-transfers] Absent (Horizon 404): ${result.absent.length}`);
      for (const a of result.absent) console.log(`[stellar-transfers]   absent ${a}`);
    }
    for (const [k, v] of result.cursors) console.log(`[stellar-transfers] cursor ${k} → ${v}`);

    if (DRY_RUN) {
      const distinctTx = new Set(sink.rows.map((r) => r.tx_signature));
      const counterparties = sink.rows.filter((r) => r.counterparty).length;
      console.log(`\n[stellar-transfers] DRY RUN — nothing was written.`);
      console.log(`[stellar-transfers]   matched rows        : ${sink.rows.length}`);
      console.log(`[stellar-transfers]   distinct tx hashes  : ${distinctTx.size}`);
      console.log(`[stellar-transfers]   rows w/ counterparty: ${counterparties}/${sink.rows.length}`);
      console.log(`[stellar-transfers]   wallets touched     : ${sink.wallets.size}`);
      console.log(`[stellar-transfers]   signal events       : ${sink.signals}`);
    }

    // A walk that errored for a non-404 reason is a real failure: its cursor did
    // not advance, so the data is delayed rather than lost, but a run that keeps
    // failing must page rather than report green.
    if (result.failed.length > 0) {
      console.error(`[stellar-transfers] FAILED addresses: ${result.failed.join(', ')}`);
      process.exit(1);
    }

    // ALL-ABSENT GUARD. A single 404 is an expected steady state, but EVERY
    // address 404ing is not — that is what a wrong STELLAR_HORIZON_URL looks
    // like, and it would otherwise exit 0 having written nothing. Green runs
    // that quietly write nothing are the 2026-08 outage shape; the per-address
    // 'absent' outcome must not reintroduce it wholesale.
    if (result.walked > 0 && result.absent.length === result.walked) {
      console.error(
        `[stellar-transfers] ALL ${result.walked} addresses returned 404 — `
        + `check STELLAR_HORIZON_URL. Refusing to report success.`,
      );
      process.exit(1);
    }
    process.exit(exitCode);
  })
  .catch((err) => {
    console.error('[stellar-transfers] Fatal error:', err);
    process.exit(1);
  });
