/**
 * Stellar behavioral (Tier 2) backfill — Autonomy Confidence + cadence.
 *
 * Fills the columns that were NULL for every Stellar agent because
 * `computeCadence` / `computeAutonomy` read the `transactions` receipt ledger,
 * which only the Solana x402 indexer populates. The activity comes from Horizon
 * instead (see src/indexer/stellar-activity.ts); the scorers themselves are
 * reused unchanged — they are chain-agnostic.
 *
 * Scope discipline (deliberate, do not "fix" these):
 *   - Writes ONLY autonomy_score / autonomy_label / metric_cadence.
 *     `score`, `provider_score`, `trust_tier`, `tx_count`, `confidence_badge`
 *     and the receipt-derived metrics are NEVER touched. Behavioral evidence is
 *     orthogonal to Karma (RFC §5.5); promoting the badge or the score off the
 *     back of it is a scoring decision, not a backfill's call. This also avoids
 *     the 2026-08-02 clobber where a wallet upsert zeroed live scores.
 *   - Uses a targeted UPDATE, never `upsertWallet` (which rewrites score +
 *     trust_tier + tx_count).
 *   - Writes NO `transactions` rows. Horizon activity is not an x402 receipt.
 *
 * Addresses come from `wallets` (chain='stellar') UNION the registry mirror's
 * owner/agent_wallet addresses, so agents that only exist per-agentId in
 * `erc8004_agents` still get their owner's behavior computed. Rows are created
 * in `wallets` only when they already exist — this never mints wallet rows.
 *
 * Usage:
 *   bun run scripts/stellar-backfill-behavior.ts --simulate
 *   bun run scripts/stellar-backfill-behavior.ts
 *   bun run scripts/stellar-backfill-behavior.ts --address G... --simulate
 */

import { fetchStellarActivity } from '../src/indexer/stellar-activity';
import { computeCadence, MIN_TX_FOR_CADENCE } from '../src/scoring/cadence';
import { computeAutonomy, MIN_TX_FOR_AUTONOMY } from '../src/scoring/autonomy';
import { buildCadenceSignal, buildAutonomySignal } from '../src/scoring/signals';
import { insertSignalEvents } from '../src/db/client';
import { supabase } from '../src/db/client';
import { requireEnv } from '../src/lib/require-env';

function argVal(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const SIMULATE = process.argv.includes('--simulate');
const ONLY_ADDRESS = argVal('address');
const CONCURRENCY = Math.max(1, Math.min(8, Number(argVal('concurrency') ?? '2')));

// Fail loudly at line 1 when the DB secrets are missing. A scheduled job whose
// credentials silently vanish is the 2026-06-23 outage: the safety net ran to
// green while writing nothing for weeks. Even --simulate reads the DB for the
// address set, so both modes need these.
requireEnv(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

// ─── Address set ─────────────────────────────────────────────────────────────

async function collectAddresses(): Promise<string[]> {
  if (ONLY_ADDRESS) return [ONLY_ADDRESS];

  const addrs = new Set<string>();

  const { data: walletRows, error: walletErr } = await supabase
    .from('wallets')
    .select('address')
    .eq('chain', 'stellar');
  if (walletErr) throw walletErr;
  for (const r of walletRows ?? []) addrs.add((r as { address: string }).address);

  // Registry-mirror agents whose owner has no wallet row yet still deserve a
  // computed behavior profile — the explore page reads their owner address.
  const { data: registryRows, error: regErr } = await supabase
    .from('erc8004_agents')
    .select('owner,agent_wallet')
    .eq('chain', 'stellar');
  if (regErr) throw regErr;
  for (const r of registryRows ?? []) {
    const row = r as { owner: string; agent_wallet: string | null };
    addrs.add(row.agent_wallet ?? row.owner);
  }

  return [...addrs];
}

// ─── Per-address work ────────────────────────────────────────────────────────

type Status = 'written' | 'simulated' | 'insufficient' | 'skipped' | 'error';

interface Outcome {
  address: string;
  status: Status;
  txCount: number;
  /** True when the Horizon walk hit its page budget — txCount is a floor, not the total. */
  capped?: boolean;
  autonomy?: number;
  label?: string;
  cadence?: number;
  error?: string;
}

// Stellar StrKey: G… Ed25519 public accounts are 56 chars, base32 (A–Z, 2–7).
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

async function processAddress(address: string): Promise<Outcome> {
  // Synthetic placeholders (the GDEMOBOND… bond-demo rows) are not real
  // accounts. They are a known, expected part of the address set — reporting
  // them as errors would bury a genuine Horizon failure in the noise.
  if (!STELLAR_ADDRESS_RE.test(address)) {
    return { address, status: 'skipped', txCount: 0, error: 'not a StrKey account (synthetic row)' };
  }

  let activity;
  let capped = false;
  try {
    activity = await fetchStellarActivity(address, { onPageCap: () => { capped = true; } });
  } catch (err) {
    return { address, status: 'error', txCount: 0, error: err instanceof Error ? err.message : String(err) };
  }

  const cadence = computeCadence(activity.map((a) => a.timestamp));
  const autonomy = computeAutonomy(activity);

  // Below the 10-tx floor both scorers return null. Leave the columns untouched
  // rather than writing a zero that would read as "measured, and it's zero".
  if (!cadence && !autonomy) {
    return { address, status: 'insufficient', txCount: activity.length };
  }

  const base: Outcome = {
    address,
    status: SIMULATE ? 'simulated' : 'written',
    txCount: activity.length,
    capped,
    autonomy: autonomy?.score,
    label: autonomy?.label,
    cadence: cadence?.automationScore,
  };
  if (SIMULATE) return base;

  // chain MUST be set explicitly: the signal builders default to the DB's
  // 'solana', which would key the row to the wrong wallet and break the FK.
  const signals = [
    ...(cadence ? [{ ...buildCadenceSignal(address, cadence), chain: 'stellar' as const }] : []),
    ...(autonomy ? [{ ...buildAutonomySignal(address, autonomy), chain: 'stellar' as const }] : []),
  ];
  await insertSignalEvents(signals, { overwrite: true });

  // Targeted UPDATE — only the behavioral columns, and only for rows that
  // already exist (no upsert, so a registry-only owner is not minted here).
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (autonomy) {
    patch.autonomy_score = autonomy.score;
    patch.autonomy_label = autonomy.label;
  }
  if (cadence) patch.metric_cadence = cadence.automationScore;

  const { error } = await supabase
    .from('wallets')
    .update(patch)
    .eq('chain', 'stellar')
    .eq('address', address);
  if (error) return { ...base, status: 'error', error: error.message };

  return base;
}

// ─── Driver ──────────────────────────────────────────────────────────────────

const addresses = await collectAddresses();
console.log(`[behavior] mode:        ${SIMULATE ? 'SIMULATE (no writes)' : 'WRITE'}`);
console.log(`[behavior] addresses:   ${addresses.length}`);
console.log(`[behavior] concurrency: ${CONCURRENCY}`);
console.log(`[behavior] floors:      cadence ≥${MIN_TX_FOR_CADENCE} tx, autonomy ≥${MIN_TX_FOR_AUTONOMY} tx`);
console.log('');

const startedAt = Date.now();
const outcomes: Outcome[] = [];
let cursor = 0;

async function worker() {
  for (;;) {
    const i = cursor++;
    if (i >= addresses.length) return;
    const o = await processAddress(addresses[i]);
    outcomes.push(o);
    const tag = o.status === 'error' ? 'ERR ' : o.status === 'skipped' ? 'SKIP' : o.status === 'insufficient' ? '----' : 'OK  ';
    const detail = o.status === 'error' || o.status === 'skipped'
      ? ` ${o.error?.slice(0, 60)}`
      : o.status === 'insufficient'
        ? ` (${o.txCount} tx — below floor)`
        : ` ${o.capped ? '≥' : ''}${o.txCount} tx${o.capped ? ' (page cap)' : ''} · autonomy ${o.autonomy ?? '—'} ${o.label ?? ''} · cadence ${o.cadence?.toFixed(3) ?? '—'}`;
    console.log(`${tag} ${o.address.slice(0, 8)}…${o.address.slice(-4)}${detail}`);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

const by = (s: Status) => outcomes.filter((o) => o.status === s).length;
console.log('');
console.log('─── summary ──────────────────────────────────────────────');
console.log(`elapsed:        ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
console.log(`addresses:      ${outcomes.length}`);
console.log(`${SIMULATE ? 'would write' : 'written    '}:    ${SIMULATE ? by('simulated') : by('written')}`);
console.log(`below floor:    ${by('insufficient')}`);
console.log(`skipped:        ${by('skipped')} (synthetic / non-StrKey rows)`);
console.log(`errors:         ${by('error')}`);
const capped = outcomes.filter((o) => o.capped).length;
if (capped > 0) {
  console.log(`page-capped:    ${capped} — history truncated at the walk budget, tx counts are floors`);
}

const scored = outcomes.filter((o) => o.autonomy != null);
if (scored.length > 0) {
  const labels: Record<string, number> = {};
  for (const o of scored) labels[o.label!] = (labels[o.label!] ?? 0) + 1;
  console.log(`autonomy labels:${JSON.stringify(labels)}`);
}

for (const o of outcomes.filter((o) => o.status === 'error').slice(0, 5)) {
  console.log(`  ${o.address}: ${o.error}`);
}

// Exit non-zero on ANY error. The first scheduled run (2026-08-05) errored on
// 12/12 real addresses — an empty STELLAR_HORIZON_URL secret broke every fetch —
// and still exited 0, so the workflow went green having written nothing. That is
// the 2026-06-23 outage shape reproduced inside its own replacement. A refresh
// job that cannot write MUST page.
//
// `skipped` (synthetic non-StrKey rows) and `insufficient` (below the 10-tx
// floor) are expected steady-state outcomes, not failures.
const errorCount = by('error');
if (errorCount > 0) {
  console.error(
    `\n[behavior] FAILED: ${errorCount}/${outcomes.length} addresses errored — see above.`,
  );
  process.exit(1);
}

// Every real address failing to produce a result is also a failure, even with a
// zero error count: it means the address set or the activity source is broken.
const eligible = outcomes.filter((o) => o.status !== 'skipped').length;
if (eligible > 0 && by('written') === 0 && by('simulated') === 0 && by('insufficient') < eligible) {
  console.error('\n[behavior] FAILED: no address produced a behavioral result.');
  process.exit(1);
}

process.exit(0);
