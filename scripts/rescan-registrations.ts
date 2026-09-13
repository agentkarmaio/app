/**
 * Re-decode agent registrations that were banked as `unreachable`.
 *
 * Why this exists
 * ---------------
 * ipfs.io retired its path gateway (2026-09-13) and began answering every
 * request with 429. `decodeRegistration` could not tell a throttle from a
 * verdict, so it wrote `unreachable` and moved on — 1,949 agents across
 * arc/celo/solana ended up recorded as publishing nothing. A 52-CID sample
 * refetched through Filebase came back 48% valid JSON.
 *
 * The scanners will not repair this on their own: `unreachable` rows are
 * excluded from the upsert (so a stored identity survives an outage), and the
 * Arc rotation only retries a quarter of each budget. This sweep re-reads them
 * once against the configured gateway and settles each row.
 *
 * Safety
 * ------
 *   - Dry run by default. `--execute` is required to write.
 *   - A retryable failure (429 / timeout / 5xx) is NEVER written: the row is
 *     left exactly as it was for a later pass. Only a settled verdict —
 *     `fetched`, or `invalid` for a body that is served but is not JSON — is
 *     persisted. Writing a throttle back is the bug this whole change removes.
 *   - Reuses `upsertErc8004Agents`, so feedback columns and `asset_address`
 *     keep the semantics every other scanner relies on.
 *
 * Usage:
 *   bun run scripts/rescan-registrations.ts --limit 200            # dry run
 *   bun run scripts/rescan-registrations.ts --chain celo --execute
 */

import { supabase, upsertErc8004Agents } from '../src/db/client';
import { decodeRegistration, type ScannedAgent } from '../src/indexer/erc8004-registry';
import { scoreMetadataQuality } from '../src/scoring/celo-metadata';
import { requireEnv } from '../src/lib/require-env';

requireEnv(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

function argVal(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function intArg(name: string, fallback: number): number {
  const raw = argVal(name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw Error(`--${name} must be a positive integer, got '${raw}'`);
  return Number(raw);
}

const chain = argVal('chain');
const limit = intArg('limit', 500);
const concurrency = intArg('concurrency', 8);
const execute = process.argv.includes('--execute');

interface Row {
  chain: string;
  agent_id: number;
  owner: string;
  agent_wallet: string | null;
  token_uri: string;
}

let query = supabase
  .from('erc8004_agents')
  .select('chain,agent_id,owner,agent_wallet,token_uri')
  .eq('registration_status', 'unreachable')
  .not('token_uri', 'is', null)
  .order('chain')
  .order('agent_id')
  .limit(limit);
if (chain) query = query.eq('chain', chain);

const { data, error } = await query;
if (error) throw error;
const rows = (data ?? []) as Row[];

console.log(`[rescan] ${rows.length} unreachable row(s)${chain ? ` on ${chain}` : ''}`);
console.log(`[rescan] gateway: ${process.env.IPFS_GATEWAY_URL ?? '(default)'}`);
console.log(`[rescan] mode: ${execute ? 'EXECUTE' : 'dry run'}`);

const tally: Record<string, number> = {};
const settled = new Map<string, ScannedAgent[]>();

let cursor = 0;
async function worker() {
  for (;;) {
    const row = rows[cursor++];
    if (!row) return;
    const dec = await decodeRegistration(row.token_uri, { fetchRemote: true });
    // A throttle is not an answer. Leave the row untouched rather than
    // re-banking the same non-verdict with a fresh timestamp.
    const key = dec.retryable ? 'still_throttled' : dec.status;
    tally[key] = (tally[key] ?? 0) + 1;
    if (dec.retryable) continue;
    if (dec.status !== 'fetched' && dec.status !== 'invalid') continue;

    const list = settled.get(row.chain) ?? [];
    list.push({
      agentId: row.agent_id,
      owner: row.owner,
      agentWallet: row.agent_wallet,
      tokenURI: row.token_uri,
      registration: dec.registration,
      registrationStatus: dec.status,
      metadataScore: scoreMetadataQuality({
        registration: dec.registration,
        tokenURI: row.token_uri,
      }).score,
    });
    settled.set(row.chain, list);
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, rows.length || 1) }, worker));

console.log('');
console.log('────────────────  summary  ────────────────');
for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(18)} ${v}`);

let written = 0;
for (const [ch, agents] of settled) {
  const recovered = agents.filter((a) => a.registrationStatus === 'fetched').length;
  console.log(`  ${ch}: ${agents.length} settled (${recovered} recovered registrations)`);
  if (execute) written += await upsertErc8004Agents(ch, agents);
}

if (execute) console.log(`\n[rescan] wrote ${written} row(s)`);
else console.log('\n[rescan] dry run — nothing written. Re-run with --execute.');
