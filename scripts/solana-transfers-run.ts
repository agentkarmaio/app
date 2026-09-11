/**
 * Manual runner for the Solana plain-USDC transfer indexer.
 *
 * MANUAL AND UNSCHEDULED, matching how arc-transfers and stellar-transfers were
 * left after their dry runs. Before this is ever put on a schedule,
 * `/api/cron/indexer`'s freshness probe must be scoped to x402 facilitators —
 * it reads `max(timestamp)` across all of them and would otherwise stay green
 * on these rows while x402 ingest was dead, which is the shape of both prior
 * ingest-gap incidents.
 *
 * WHY THE DEFAULT RUN IS SO NARROW. Measured 2026-09-10: of the providers with
 * no outbound rows, only ~29% have any outbound USDC at all — the rest are
 * revenue sinks, for which `insufficient-data` is the correct and permanent
 * answer. `--spenders-only` applies that filter with ONE `getTokenAccountBalance`
 * per wallet, which is cheap, and skips the ~71% that would cost a full history
 * walk to learn nothing. The archive RPC serves ~0.6 req/s, so this is the
 * difference between a 6-hour run and a 20-hour one.
 *
 * The balance filter is scoped to wallets with NO facilitator-routed outbound.
 * On a wallet that already has x402 outbound rows, a low balance reflects
 * payments AK has ALREADY recorded, so the filter would misfire.
 *
 * Flags:
 *   --dry-run          decode and report; write nothing
 *   --limit=N          cap wallets walked this run
 *   --since-days=N     seed window (default 90)
 *   --spenders-only    pre-filter to wallets whose balance proves they spend
 *   --payee-only       restrict to providers with zero outbound rows (the gap)
 *   --max-signatures=N per-wallet signature cap (default 200)
 *   --concurrency=N    parallel wallet walks (default 1 — see ADDRESS_CONCURRENCY)
 *   --time-budget-min=N wall-clock ceiling for the run (default 30)
 *   --state=PATH       seed snapshot (default .tmp/solana-transfers-seed.json)
 *   --reseed           discard the snapshot and derive a fresh seed set
 *   --addresses=A,B    walk exactly these wallets, bypassing the seed read.
 *                      Naming an address IS the intentional act, so no marker
 *                      gate applies — use it to re-walk one wallet or to verify
 *                      a change without a 1,220-address seed derivation.
 *
 * Usage:
 *   bun run scripts/solana-transfers-run.ts --dry-run --payee-only --limit=20
 *   bun run scripts/solana-transfers-run.ts --payee-only --spenders-only
 *
 * Spec: (design notes, kept out of this repo)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { supabase, withTransientDbRetry } from '../src/db/client';
import { getArchiveRpcUrl } from '../src/indexer/helius';
import { USDC_MINT } from '../src/config/facilitators';
import {
  SOLANA_TRANSFER_EXCLUSIONS,
  deriveSolanaProviderSeed,
  runSolanaTransfersIndexer,
} from '../src/indexer/solana-transfers';

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
const SPENDERS_ONLY = args.includes('--spenders-only');
const PAYEE_ONLY = args.includes('--payee-only');
const LIMIT = flag('limit') ? num('limit', 0) : Infinity;
const SINCE_DAYS = num('since-days', 90);
const MAX_SIGNATURES = num('max-signatures', 200);
const CONCURRENCY = num('concurrency', 1);
const TIME_BUDGET_MIN = num('time-budget-min', 30);
const STATE_PATH = flag('state') ?? '.tmp/solana-transfers-seed.json';
const ADDRESSES = flag('addresses')?.split(',').map((a) => a.trim()).filter(Boolean) ?? null;

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const USDC_PK = new PublicKey(USDC_MINT);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Seed snapshot ───────────────────────────────────────────────────────────

interface State {
  seededAt: string;
  sinceDays: number;
  /** Provider wallets in scope. Fixed for the life of the snapshot. */
  seed: string[];
}

function loadState(): State | null {
  if (RESEED || !existsSync(STATE_PATH)) return null;
  const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as State;
  if (!Array.isArray(parsed.seed)) throw new Error(`${STATE_PATH} is not a valid state file`);
  // Re-apply exclusions to a SNAPSHOT. A snapshot taken before an address was
  // exclusion-listed still names it, and `loadState` is the one path that
  // bypasses `buildSolanaSeedSet` entirely — so without this, adding a router
  // to the list would not take effect until someone remembered `--reseed`.
  const dropped = parsed.seed.filter((a) => SOLANA_TRANSFER_EXCLUSIONS.has(a));
  if (dropped.length > 0) {
    console.log(`[solana-transfers] dropped ${dropped.length} now-excluded address(es) from the snapshot`);
    parsed.seed = parsed.seed.filter((a) => !SOLANA_TRANSFER_EXCLUSIONS.has(a));
  }
  return parsed;
}

function saveState(state: State): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ─── Scope narrowing ─────────────────────────────────────────────────────────

/**
 * Providers with ZERO facilitator-routed outbound rows — the population that is
 * actually blocked on `insufficient-data`.
 *
 * Asked as "which of these appear as `wallet_address` on an x402 row", then
 * subtracted, because a NOT-IN over 1,220 addresses is the query PostgREST
 * handles worst.
 */
async function withoutOutbound(seed: string[]): Promise<string[]> {
  const out: string[] = [];
  // ONE EXISTENCE CHECK PER ADDRESS, not a chunked `.in()` read.
  //
  // The chunked version is the obvious shape and it is wrong here: `.in(...)`
  // returns ROWS, not distinct wallets, and a single busy provider carries
  // ~1000 outbound rows (measured: EVmGpcYz…, 2Evk5PPE…, CjHkmudk…). One of
  // those saturates the page, every other wallet in the chunk is missing from
  // the result, and they are then FALSELY classified as payee-only — walked
  // needlessly, and mis-measured by --spenders-only, whose balance test is
  // invalid on a wallet whose outbound AK already recorded.
  //
  // NO facilitator filter. `computeReciprocity` reads EVERY outbound row
  // regardless of how it was ingested, so "blocked on insufficient-data" means
  // zero outbound rows full stop. An earlier `.in(ALL_FACILITATOR_ADDRESSES)`
  // here had the same defect as the seed guard did — it would have called a
  // wallet payee-only when its only outbound went through a facilitator missing
  // from the auto-generated config (measured: 2 such facilitators carry 871 of
  // the 1,221 payees). It also makes this self-limiting: once this job writes a
  // wallet's rows, it stops being payee-only and later runs skip it.
  //
  // `idx_transactions_chain_wallet_address` makes each of these a point lookup,
  // so ~1,220 of them cost about a minute — nothing against the RPC walk that
  // follows.
  //
  // Retried: a bare `throw error` here discards the whole prelude on one
  // transient cancel, and the run behind it — which is exactly how the
  // 2026-09-11 seed derivation died. The throw lives INSIDE the retried fn
  // because supabase-js returns `{ error }` rather than throwing, so a wrapper
  // around the query alone would retry nothing.
  for (const address of seed) {
    const rows = await withTransientDbRetry(async () => {
      const { data, error } = await supabase
        .from('transactions')
        .select('tx_signature')
        .eq('chain', 'solana')
        .eq('wallet_address', address)
        .limit(1);
      if (error) throw error;
      return data ?? [];
    });
    if (rows.length === 0) out.push(address);
  }
  return out;
}

/** The USDC inbound AK has observed for one address. A LOWER BOUND, never total. */
async function observedInbound(address: string): Promise<number> {
  let total = 0;
  for (let off = 0; off < 10_000; off += 1000) {
    const { data, error } = await supabase
      .from('transactions')
      .select('amount')
      .eq('chain', 'solana')
      .eq('counterparty', address)
      .range(off, off + 999);
    if (error) throw error;
    const page = (data ?? []) as Array<{ amount: string | number }>;
    for (const r of page) total += Number(r.amount);
    if (page.length < 1000) break;
  }
  return total;
}

const ataOf = (owner: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), USDC_PK.toBuffer()],
    ATA_PROGRAM,
  )[0];

/**
 * Keep only wallets whose live USDC balance PROVES they moved USDC out.
 *
 * `balance = all_inbound − all_outbound`, and our observed inbound is a lower
 * bound on `all_inbound`. So:
 *   - `balance ≪ observed_inbound` ⇒ `all_outbound > 0`. Decisive; keep it.
 *   - `balance ≥ observed_inbound` ⇒ outbound is bounded by inbound we never
 *     measured. NOT decisive — this filter drops those, which means it trades a
 *     ~4× cost reduction for a recall it cannot quantify. That trade is the
 *     reason the flag is opt-in rather than the default.
 */
async function spendersOnly(addresses: string[]): Promise<string[]> {
  const conn = new Connection(getArchiveRpcUrl(), 'confirmed');
  const keep: string[] = [];
  for (const [i, address] of addresses.entries()) {
    const inbound = await observedInbound(address);
    let balance: number | null = null;
    try {
      balance = (await conn.getTokenAccountBalance(ataOf(new PublicKey(address)))).value.uiAmount ?? 0;
    } catch {
      // No canonical USDC account, or the RPC refused. Unknown, not a sink —
      // keep it rather than silently dropping a wallet we failed to measure.
      // Back off anyway: a 429 is the likeliest cause, and skipping the delay
      // would fire the next call straight into the same limit.
      await sleep(300);
      keep.push(address);
      continue;
    }
    await sleep(300);
    if (inbound > 0 && balance < inbound * 0.5) keep.push(address);
    if ((i + 1) % 50 === 0) console.log(`[filter] ${i + 1}/${addresses.length} checked, ${keep.length} spenders`);
  }
  return keep;
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log(`[solana-transfers] mode: ${DRY_RUN ? 'DRY-RUN (no writes)' : 'WRITE'}`);
console.log(`[solana-transfers] rpc: ${getArchiveRpcUrl()}  state: ${STATE_PATH}`);

let state = loadState();
if (ADDRESSES) {
  // Explicit address list: skip the seed read entirely and skip the snapshot,
  // so a one-off walk can never overwrite the run's real scope.
  state = { seededAt: new Date().toISOString(), sinceDays: SINCE_DAYS, seed: ADDRESSES };
  console.log(`[solana-transfers] walking ${ADDRESSES.length} explicitly named wallet(s)`);
} else if (state) {
  console.log(`[solana-transfers] resumed snapshot from ${state.seededAt}: ${state.seed.length} provider wallets`);
} else {
  console.log(`[solana-transfers] deriving seed (x402 payees from the last ${SINCE_DAYS}d)…`);
  const seed = await deriveSolanaProviderSeed({
    sinceDays: SINCE_DAYS,
    onProgress: (scanned, found) => console.log(`[seed] scanned ${scanned} rows, ${found} payees…`),
  });
  state = { seededAt: new Date().toISOString(), sinceDays: SINCE_DAYS, seed };
  // Persist even in dry-run: the point is that the SAME scope is used for real.
  saveState(state);
  console.log(`[solana-transfers] seeded ${seed.length} provider wallets -> ${STATE_PATH}`);
}

let targets = state.seed;
if (PAYEE_ONLY) {
  targets = await withoutOutbound(targets);
  console.log(`[solana-transfers] ${targets.length} have NO outbound rows at all (the blocked population)`);
}
if (SPENDERS_ONLY) {
  console.log(`[solana-transfers] balance-filtering ${targets.length} wallets (~1 RPC call each)…`);
  targets = await spendersOnly(targets);
  console.log(`[solana-transfers] ${targets.length} provably spend`);
}
if (Number.isFinite(LIMIT) && targets.length > LIMIT) {
  targets = targets.slice(0, LIMIT);
  console.log(`[solana-transfers] capped to ${targets.length} wallets by --limit`);
}

if (targets.length === 0) {
  console.log('[solana-transfers] nothing to walk');
  process.exit(0);
}

const started = Date.now();
let wouldWrite = 0;
const result = await runSolanaTransfersIndexer({
  only: targets,
  maxSignatures: MAX_SIGNATURES,
  concurrency: CONCURRENCY,
  timeBudgetMs: TIME_BUDGET_MIN * 60_000,
  // A dry run still walks and decodes; only the three writes become no-ops, so
  // the reported counts are exactly what a real run would persist.
  ...(DRY_RUN
    ? {
        overrides: {
          insertTransactions: async (rows) => {
            for (const row of rows.slice(0, Math.max(0, 5 - wouldWrite))) {
              console.log(`    ${row.tx_signature.slice(0, 10)}… ${row.wallet_address.slice(0, 6)}… -> ${String(row.counterparty).slice(0, 6)}…  ${row.amount} USDC`);
            }
            wouldWrite += rows.length;
            return rows.length;
          },
          insertSignalEvents: async (s) => s.length,
          ensureWallets: async () => {},
          upsertCursor: async () => {},
        },
      }
    : {}),
});

const mins = ((Date.now() - started) / 60_000).toFixed(1);
console.log(`\n[solana-transfers] done in ${mins} min`);
console.log(`  wallets walked:        ${result.scanned}`);
console.log(`  ${DRY_RUN ? 'would write' : 'rows written'}:  ${result.inserted}`);
console.log(`  multi-leg (one leg kept): ${result.multiCredit}`);
console.log(`  unresolved (retry next run): ${result.unresolved}`);
console.log(`  failed wallets:        ${result.failed.length}`);
for (const [reason, n] of Object.entries(result.skipped).sort((a, b) => b[1] - a[1])) {
  console.log(`  skipped ${reason}: ${n}`);
}
if (DRY_RUN) console.log('\n[solana-transfers] DRY-RUN — no rows were written and no cursor moved');
