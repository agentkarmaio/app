/**
 * Backfill `transactions.counterparty` for Solana PROVIDER wallets.
 *
 * Rows written before 2026-06-20 have `counterparty = NULL` — the column did
 * not exist yet. That suppresses the coverage gate in scoring/reciprocity.ts,
 * so the revenue-independence signal declines to answer for wallets whose
 * payees are invisible. The payee is recoverable: every row carries a unique
 * `tx_signature`, so the transaction can be refetched and run through the
 * indexer's own decoder.
 *
 * Scope is provider wallets only — addresses seen as `counterparty` on recent
 * rows. All 503k nulls is the wrong unit of work; those belong overwhelmingly
 * to payer wallets nobody asks an independence question about. Measured scope
 * is 592 rows across 1,220 provider wallets (see the spec).
 *
 * SAFETY: this never invents a payee. `decideCounterpartyWrite()` refuses
 * unless the refetched payment matches the stored row on signature, payer and
 * amount, and names a payee. A refused row stays NULL.
 *
 * Flags:
 *   --dry-run          decode and report; write nothing
 *   --limit=N          cap rows processed this run
 *   --since-days=N     seed window (default 90)
 *   --rpc-url=URL      RPC endpoint (default api.mainnet-beta.solana.com)
 *   --delay-ms=N       inter-request delay (default 300)
 *   --state=PATH       seed snapshot + skip-list
 *   --reseed           discard the snapshot and derive a fresh seed set
 *
 * Usage:
 *   bun run scripts/backfill-solana-counterparty.ts --dry-run --limit=50
 *   bun run scripts/backfill-solana-counterparty.ts
 *
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Connection } from '@solana/web3.js';
import { supabase, ADDRESS_IN_CHUNK } from '../src/db/client';
import { mapParsedTxToEnhanced, extractX402Payment } from '../src/indexer/helius';
import {
  decideCounterpartyWrite,
  isConclusivelyNull,
  type BackfillRow,
} from '../src/indexer/counterparty-backfill';
import { SEED_SCAN_CAP, deriveSolanaProviderSeed } from '../src/indexer/solana-transfers';

// ─── Flags ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const num = (name: string, fallback: number): number => {
  const raw = flag(name);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const DRY_RUN = args.includes('--dry-run');
const RESEED = args.includes('--reseed');
const LIMIT = flag('limit') ? num('limit', 0) : Infinity;
const SINCE_DAYS = num('since-days', 90);
const RPC_URL = flag('rpc-url') ?? 'https://api.mainnet-beta.solana.com';
const DELAY_MS = num('delay-ms', 300);
const STATE_PATH = flag('state') ?? '.tmp/solana-counterparty-backfill.json';

const PAGE = 1000;
/** Rows pulled per working batch. Small enough that a kill loses little. */
const BATCH = 100;
/** Persist after each batch, so a kill keeps everything already decided. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── State ───────────────────────────────────────────────────────────────────

/**
 * The seed set is SNAPSHOTTED, not re-derived on resume.
 *
 * This job writes the same `counterparty` column the seed is read from. Re-deriving
 * it mid-run would be a fixed-point iteration rather than a filter: each batch we
 * write adds new addresses to the very set that defines our scope, and the run
 * never terminates on a stable population. Snapshot once, reuse until --reseed.
 */
interface State {
  seededAt: string;
  sinceDays: number;
  /** Provider wallets in scope. Fixed for the life of the snapshot. */
  seed: string[];
  /**
   * Signatures whose decode ran to completion and established there is no payee
   * to write (see `isConclusivelyNull`). They are correctly NULL and re-running
   * reaches the same answer, so they leave the working set instead of costing a
   * refetch on every future run. An RPC miss is NOT recorded here — that is
   * retry-eligible — and neither is a decoder/row disagreement, which should
   * stay visible until someone looks at it.
   */
  skip: string[];
}

function loadState(): State | null {
  if (RESEED || !existsSync(STATE_PATH)) return null;
  const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as State;
  if (!Array.isArray(parsed.seed) || !Array.isArray(parsed.skip)) {
    throw new Error(`${STATE_PATH} is not a valid state file`);
  }
  return parsed;
}

function saveState(state: State): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ─── Seed derivation ─────────────────────────────────────────────────────────
//
// Shared with src/indexer/solana-transfers.ts via `deriveSolanaProviderSeed()`.
// This script used to derive the seed itself, with NO filter on `facilitator`.
// That was safe only while every Solana row came from the x402 path. Once the
// plain-transfer indexer writes rows (whose `counterparty` is an ordinary
// payee and whose `facilitator` is the USDC mint), an unfiltered re-seed here
// would nominate CEX deposit addresses and DEX vaults as "provider wallets" and
// queue their null rows for RPC fetches — one hop per --reseed into a
// transitive closure over the USDC payment graph.
//
// One definition of "who is a provider", one closure guard, both callers. An
// EXISTING snapshot predates any plain-transfer row and is therefore clean; it
// is the next `--reseed` that needed this.

// ─── Work discovery ──────────────────────────────────────────────────────────

/**
 * Null-counterparty outbound rows for the seeded wallets.
 *
 * `counterparty IS NULL` is itself the cursor: a row we write leaves the set, so
 * progress is durable without a row offset that could advance past something we
 * never processed. The skip-list carries the rows that stay NULL legitimately.
 */
async function fetchWork(seed: string[], skip: ReadonlySet<string>): Promise<BackfillRow[]> {
  const rows: BackfillRow[] = [];
  for (let i = 0; i < seed.length; i += ADDRESS_IN_CHUNK) {
    const chunk = seed.slice(i, i + ADDRESS_IN_CHUNK);
    // Page within the chunk. PostgREST caps a response at 1000 rows, and a
    // silently truncated work set is the worst failure shape for a backfill:
    // the run reports success having never seen the rows it dropped.
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .from('transactions')
        .select('tx_signature, wallet_address, facilitator, amount')
        .eq('chain', 'solana')
        .is('counterparty', null)
        .in('wallet_address', chunk)
        .order('tx_signature', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      const page = (data ?? []) as BackfillRow[];
      for (const row of page) {
        if (!skip.has(row.tx_signature)) rows.push(row);
      }
      if (page.length < PAGE) break;
    }
  }
  return rows;
}

// ─── Main ────────────────────────────────────────────────────────────────────

const conn = new Connection(RPC_URL, 'confirmed');

console.log(`[backfill] mode: ${DRY_RUN ? 'DRY-RUN (no writes)' : 'WRITE'}`);
console.log(`[backfill] rpc: ${RPC_URL}  delay: ${DELAY_MS}ms  state: ${STATE_PATH}`);

let state = loadState();
if (state) {
  console.log(`[backfill] resumed snapshot from ${state.seededAt}: ${state.seed.length} provider wallets, ${state.skip.length} skip-listed`);
} else {
  console.log(`[backfill] deriving seed set (payees on rows from the last ${SINCE_DAYS}d)…`);
  const seed = await deriveSolanaProviderSeed({
    sinceDays: SINCE_DAYS,
    scanCap: SEED_SCAN_CAP,
    onProgress: (scanned, found) => console.log(`[seed] scanned ${scanned} rows, ${found} distinct payees…`),
  });
  state = { seededAt: new Date().toISOString(), sinceDays: SINCE_DAYS, seed, skip: [] };
  // Persist the snapshot even in dry-run: the point is that the SAME scope is
  // used on the real run.
  saveState(state);
  console.log(`[backfill] seeded ${seed.length} provider wallets -> ${STATE_PATH}`);
}

const skip = new Set(state.skip);
const work = await fetchWork(state.seed, skip);
console.log(`[backfill] ${work.length} null-counterparty rows in scope`);
if (work.length === 0) {
  console.log('[backfill] nothing to do');
  process.exit(0);
}

const planned = Number.isFinite(LIMIT) ? work.slice(0, LIMIT) : work;
if (planned.length < work.length) console.log(`[backfill] capped to ${planned.length} rows by --limit`);

const est = (planned.length * (DELAY_MS + 1500)) / 1000;
console.log(`[backfill] estimated ~${Math.round(est / 60)} min at this rate\n`);

let written = 0;
let unfetched = 0;
const skipped: Record<string, number> = {};
const samples: string[] = [];
const startedAt = Date.now();

for (let i = 0; i < planned.length; i += BATCH) {
  const batch = planned.slice(i, i + BATCH);
  const newlySkipped: string[] = [];

  for (const row of batch) {
    let parsed = null;
    try {
      parsed = await conn.getParsedTransaction(row.tx_signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
    } catch (err) {
      console.warn(`[backfill] fetch failed ${row.tx_signature.slice(0, 12)}…: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
    }
    if (DELAY_MS) await sleep(DELAY_MS);

    // An RPC miss is retry-eligible: the payee may well be derivable, we just
    // did not get it this time. Never skip-listed.
    if (!parsed) { unfetched++; continue; }

    const mapped = mapParsedTxToEnhanced(parsed, row.tx_signature);
    const payment = mapped ? extractX402Payment(mapped, row.facilitator) : null;
    const decision = decideCounterpartyWrite(row, payment);

    if (decision.action === 'skip') {
      skipped[decision.reason] = (skipped[decision.reason] ?? 0) + 1;
      if (isConclusivelyNull(decision.reason)) newlySkipped.push(row.tx_signature);
      continue;
    }

    if (samples.length < 5) {
      samples.push(`    ${row.tx_signature.slice(0, 10)}… payer ${row.wallet_address.slice(0, 6)}… -> payee ${decision.counterparty.slice(0, 6)}… (facil ${row.facilitator.slice(0, 6)}…, ${row.amount})`);
    }

    if (DRY_RUN) { written++; continue; }

    // One column, one row, keyed by the unique signature. NOT an upsert — a
    // partially-constructed upsert row is what zeroed live scores before.
    // `.is(counterparty, null)` makes it a compare-and-set: this job only ever
    // fills a hole, and can never clobber a payee the live indexer wrote while
    // the run was in flight.
    const { error } = await supabase
      .from('transactions')
      .update({ counterparty: decision.counterparty })
      .eq('tx_signature', row.tx_signature)
      .is('counterparty', null);
    if (error) throw error;
    written++;
  }

  // Persist per batch so a kill keeps everything already decided. Writes are
  // already durable in the DB; this is the skip-list catching up.
  if (!DRY_RUN && newlySkipped.length > 0) {
    state.skip.push(...newlySkipped);
    saveState(state);
  }
  const done = Math.min(i + BATCH, planned.length);
  console.log(`[backfill] ${done}/${planned.length}  written ${written}  unfetched ${unfetched}  skipped ${Object.values(skipped).reduce((a, b) => a + b, 0)}`);
}

const mins = ((Date.now() - startedAt) / 60_000).toFixed(1);
console.log(`\n[backfill] done in ${mins} min`);
console.log(`  ${DRY_RUN ? 'would write' : 'written'}: ${written}`);
console.log(`  unfetched (retry-eligible): ${unfetched}`);
for (const [reason, n] of Object.entries(skipped).sort((a, b) => b[1] - a[1])) {
  console.log(`  skipped ${reason}: ${n}`);
}
if (samples.length > 0) {
  console.log(`\n  sample derivations:`);
  samples.forEach((s) => console.log(s));
}
if (DRY_RUN) console.log('\n[backfill] DRY-RUN — no rows were modified');
