/**
 * CLI: bun run src/indexer/solana-registry-run.ts [flags]
 *
 * Mirrors the 8004-solana registry into `erc8004_agents` — one row per agentId,
 * carrying the asset NFT pubkey that on-chain feedback writes require. The
 * Solana counterpart to `erc8004-registry-run.ts` / `stellar-registry-run.ts`.
 *
 *   --from-offset <n>  first row offset (default 0 — resume a partial sweep)
 *   --page-size <n>    rows per request (default/max 250, the upstream cap)
 *   --max-agents <n>   stop after N mapped agents (default: whole registry)
 *   --no-remote        skip http/ipfs registration fetches (inline-only, fast)
 *   --dry-run          scan + log, NO DB writes
 *
 * ⚠️ This mirror is SUPPLEMENTARY. Solana's canonical agent population stays the
 * `wallets` table (94,913 indexed x402 wallets) — see the header of
 * `solana-registry.ts` and `isRegistryMirrorChain`.
 *
 * Feedback is NOT mirrored in this pass: `feedback_count`/`avg` come denormalized
 * on the indexed agent row, so `erc8004_agents` is complete, but per-rater rows
 * in `erc8004_feedback` need a separate `searchFeedback` sweep.
 *
 * Env: SOLANA_RPC_URL (optional — the indexer API is keyless; the SDK only needs
 *      an RPC for chain reads this scanner does not perform),
 *      NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (required unless --dry-run).
 */

import { SolanaSDK } from '8004-solana';
import { Keypair } from '@solana/web3.js';
import { makeSolanaRegistryReader, scanSolanaRegistry } from '@/indexer/solana-registry';
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
const fromOffset = numArg('from-offset') ?? 0;
const pageSize = numArg('page-size') ?? 250;
const maxAgents = numArg('max-agents');
const fetchRemote = !flag('no-remote');

if (!dryRun) requireEnv(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

console.log(`[solana-registry] mode:        ${dryRun ? 'DRY RUN (no writes)' : 'WRITE'}`);
console.log(`[solana-registry] from-offset: ${fromOffset}`);
console.log(`[solana-registry] page-size:   ${pageSize}`);
console.log(`[solana-registry] max-agents:  ${maxAgents ?? 'all'}`);
console.log(`[solana-registry] remote uris: ${fetchRemote ? 'fetched' : 'skipped (pending)'}`);
console.log('');

const startedAt = Date.now();

// The SDK requires a signer at construction, but this scanner only ever READS
// through the indexer API. A throwaway keypair keeps the real validator key out
// of a read-only process entirely — it is never used to sign anything.
const rpcUrl = process.env.SOLANA_RPC_URL;
const sdk = new SolanaSDK({
  signer: Keypair.generate(),
  cluster: 'mainnet-beta',
  ...(rpcUrl ? { rpcUrl } : {}),
});

const result = await scanSolanaRegistry({
  reader: makeSolanaRegistryReader(sdk),
  fromOffset,
  pageSize,
  maxAgents,
  fetchRemote,
  onProgress: (total, offset) => {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(`[${elapsed.padStart(4)}s] offset ${String(offset).padStart(5)} — ${total} agents mapped`);
  },
});

console.log('');
console.log(`[solana-registry] pages fetched:      ${result.pagesFetched}`);
console.log(`[solana-registry] agents scanned:     ${result.agents.length}`);
console.log(`[solana-registry] skipped (no id):    ${result.skippedNoAgentId}`);
console.log(`[solana-registry] duplicate ids:      ${result.duplicates}`);
console.log(`[solana-registry] page errors:        ${result.errors.length}`);

const byStatus: Record<string, number> = {};
for (const a of result.agents) byStatus[a.registrationStatus] = (byStatus[a.registrationStatus] ?? 0) + 1;
console.log(`[solana-registry] statuses:           ${JSON.stringify(byStatus)}`);

const withAsset = result.agents.filter((a) => a.assetAddress).length;
console.log(`[solana-registry] with asset pubkey:  ${withAsset}/${result.agents.length}`);

if (result.errors.length > 0) {
  // A page error is a GAP in coverage, not a slow row — say so loudly, or a
  // partial sweep reads as a complete one.
  console.log('');
  console.log(`⚠️  ${result.errors.length} page(s) failed — those offsets were NOT scanned:`);
  for (const e of result.errors.slice(0, 5)) console.log(`  offset ${e.offset}: ${e.error}`);
}

if (dryRun) {
  console.log('');
  console.log('[solana-registry] dry run — no rows written');
  process.exit(0);
}

// Imported lazily so --dry-run never needs Supabase credentials.
const { upsertErc8004Agents } = await import('@/db/client');
const written = await upsertErc8004Agents('solana', result.agents);
console.log('');
console.log(`[solana-registry] erc8004_agents rows upserted: ${written}`);
console.log(`[solana-registry] elapsed: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
process.exit(0);
