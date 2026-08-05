/**
 * CLI: bun run src/indexer/stellar-registry-run.ts [flags]
 *
 * Mirrors the Stellar (trionlabs/stellar-8004) IdentityRegistry into the
 * `erc8004_agents` table — one row per agentId, so AK's Stellar population
 * reflects reality instead of the owner-collapsed `wallets` view. The Soroban
 * counterpart to `erc8004-registry-run.ts`.
 *
 *   --from <id>        first agentId (default 0 — Stellar ids are sequential from 0)
 *   --to <id>          last agentId (default = total_agents() - 1)
 *   --concurrency <n>  parallel workers (default 2; the public RPC throttles above that)
 *   --no-remote        skip http/ipfs registration fetches (inline-only, fast)
 *   --dry-run          scan + log, NO DB writes
 *
 * Feedback is NOT mirrored: the Soroban ReputationRegistry's `get_summary` caps
 * at 5 client addresses per call and offers no rater enumeration, so there is no
 * cheap per-agent feedback pass yet. `feedback_count` stays 0 for Stellar rows.
 *
 * Env: STELLAR_RPC_URL (optional override),
 *      NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (required unless --dry-run).
 */

import { getStellarRpc } from '@/integrations/erc8004-stellar';
import { makeStellarRegistryReader, scanStellarRegistry } from '@/indexer/stellar-registry';
import { requireEnv } from '@/lib/require-env';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function numArg(name: string): number | undefined {
  const v = arg(name);
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

const dryRun = flag('dry-run');
const from = numArg('from') ?? 0;
const to = numArg('to');
const concurrency = numArg('concurrency') ?? 2;
const fetchRemote = !flag('no-remote');

if (!dryRun) requireEnv(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

console.log(`[stellar-registry] mode:        ${dryRun ? 'DRY RUN (no writes)' : 'WRITE'}`);
console.log(`[stellar-registry] from:        ${from}`);
console.log(`[stellar-registry] to:          ${to ?? 'total_agents() - 1'}`);
console.log(`[stellar-registry] concurrency: ${concurrency}`);
console.log(`[stellar-registry] remote uris: ${fetchRemote ? 'fetched' : 'skipped (pending)'}`);
console.log('');

const startedAt = Date.now();
const reader = makeStellarRegistryReader(getStellarRpc());

let done = 0;
const result = await scanStellarRegistry({
  reader,
  from,
  to,
  concurrency,
  fetchRemote,
  onProgress: (agentId, outcome) => {
    done++;
    if (done % 10 === 0 || outcome === 'error') {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
      console.log(`[${elapsed.padStart(4)}s] ${String(done).padStart(4)} probed — agent ${agentId} ${outcome}`);
    }
  },
});

console.log('');
console.log(`[stellar-registry] attempted: ${result.attempted}`);
console.log(`[stellar-registry] scanned:   ${result.agents.length}`);
console.log(`[stellar-registry] missing:   ${result.missing}`);
console.log(`[stellar-registry] errors:    ${result.errors.length}`);

const byStatus: Record<string, number> = {};
for (const a of result.agents) byStatus[a.registrationStatus] = (byStatus[a.registrationStatus] ?? 0) + 1;
console.log(`[stellar-registry] statuses:  ${JSON.stringify(byStatus)}`);

if (result.errors.length > 0) {
  console.log('');
  console.log(`first ${Math.min(5, result.errors.length)} errors:`);
  for (const e of result.errors.slice(0, 5)) console.log(`  agent ${e.agentId}: ${e.error}`);
}

if (dryRun) {
  console.log('');
  console.log('[stellar-registry] dry run — no rows written');
  process.exit(0);
}

// Imported lazily so --dry-run never needs Supabase credentials.
const { upsertErc8004Agents } = await import('@/db/client');
const written = await upsertErc8004Agents('stellar', result.agents);
console.log('');
console.log(`[stellar-registry] erc8004_agents rows upserted: ${written}`);
console.log(`[stellar-registry] elapsed: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
process.exit(0);
