/**
 * Endpoint-driven x402 payee self-seeder for the Celo settlement indexer.
 *
 * The Celo x402 indexer (src/indexer/celo-x402.ts) is a deliberate no-op until a
 * facilitator/payee address is seeded. Celo has no canonical x402 facilitator,
 * and heuristic on-chain discovery (scripts/celo-discover-facilitators.ts) only
 * surfaces DEX routers. The reliable signal is the agent's OWN declaration: a
 * real x402 paywall answers an unpaid request with HTTP **402** and a JSON
 * `accepts` body carrying `payTo`.
 *
 * This script:
 *   1. pages indexed Celo agents from `erc8004_agents` (registration JSON has
 *      `services: {name, endpoint}[]`),
 *   2. probes each declared HTTP(S) service endpoint with the SSRF guard
 *      (safeFetchWithStatus — every hop host-validated, body capped, short
 *      timeout, bounded concurrency),
 *   3. on a real HTTP 402, parses the `accepts` body and extracts every `payTo`
 *      whose network is Celo mainnet and asset is a known Celo stablecoin
 *      (extractCeloPayees),
 *   4. persists each into `celo_x402_payees` — the indexer unions VERIFIED rows
 *      into its match set on the next run.
 *
 * ATTRIBUTION-POISONING GUARD: a malicious agent could declare a victim's
 * address as `payTo`, making AK attribute the victim's stablecoin transfers as
 * the agent's provider signal. A payee is marked `verified` ONLY when it is
 * self-controlled by the source agent — `payTo` equals the agent's owner OR its
 * agentWallet on the IdentityRegistry. Cross-address declarations are still
 * persisted (for audit + later corroboration) but `verified=false`, and the
 * indexer NEVER feeds unverified rows into its match set.
 *
 * Usage:
 *   bun run scripts/celo-x402-discover-payees.ts [--dry-run]
 *     [--max-agents N] [--concurrency N] [--timeout-ms N] [--from-offset N]
 *
 *   --dry-run     probe + report, write NOTHING to the DB (default for inspection)
 *   --max-agents  cap how many agents are walked (default: all). Sampling is
 *                 LOGGED explicitly so a partial pass never reads as "scanned all".
 *   --concurrency parallel endpoint probes (default 8)
 *   --timeout-ms  per-probe timeout (default 6000)
 *   --from-offset agent page offset to resume from (default 0)
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (DB load).
 */

import { safeFetchWithStatus, SsrfError } from '../src/lib/ssrf-guard';
import { extractCeloPayees, type ExtractedPayee } from '../src/lib/x402-accepts';
import {
  listErc8004AgentsPage,
  upsertCeloX402Payee,
  type Erc8004AgentLite,
} from '../src/db/client';

// ─── CLI ────────────────────────────────────────────────────────────────────

function argVal(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
function argFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function numArg(name: string, fallback: number): number {
  const raw = argVal(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const DRY_RUN = argFlag('dry-run');
const MAX_AGENTS = argVal('max-agents') ? numArg('max-agents', Infinity) : Infinity;
const CONCURRENCY = Math.max(1, Math.min(16, numArg('concurrency', 8)));
const TIMEOUT_MS = numArg('timeout-ms', 6000);
const FROM_OFFSET = (() => {
  const raw = argVal('from-offset');
  if (raw === undefined) return 0;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : 0;
})();
const PAGE_SIZE = 1000;
const CHAIN = 'celo' as const;

console.log('[discover-payees] Celo x402 endpoint-driven payee self-seeder');
console.log(`[discover-payees] mode:        ${DRY_RUN ? 'DRY-RUN (no DB writes)' : 'WRITE'}`);
console.log(`[discover-payees] max-agents:  ${Number.isFinite(MAX_AGENTS) ? MAX_AGENTS : 'all'}`);
console.log(`[discover-payees] concurrency: ${CONCURRENCY}`);
console.log(`[discover-payees] timeout:     ${TIMEOUT_MS}ms`);
console.log(`[discover-payees] from-offset: ${FROM_OFFSET}`);
console.log('');

// ─── Endpoint extraction ──────────────────────────────────────────────────────

interface Candidate {
  agentId: number;
  /** Lowercased owner + agentWallet — the set of self-controlled addresses. */
  selfAddresses: Set<string>;
  endpoint: string;
}

/** Pull distinct HTTP(S) service endpoints from one agent's registration JSON. */
function endpointsFor(agent: Erc8004AgentLite): string[] {
  const reg = agent.registration as { services?: unknown } | null;
  if (!reg || typeof reg !== 'object' || !Array.isArray(reg.services)) return [];
  const out = new Set<string>();
  for (const s of reg.services) {
    const ep = (s as { endpoint?: unknown })?.endpoint;
    if (typeof ep === 'string' && /^https?:\/\//i.test(ep.trim())) {
      out.add(ep.trim());
    }
  }
  return [...out];
}

function selfAddressesFor(agent: Erc8004AgentLite): Set<string> {
  const set = new Set<string>();
  if (agent.owner) set.add(agent.owner.toLowerCase());
  if (agent.agent_wallet) set.add(agent.agent_wallet.toLowerCase());
  return set;
}

// ─── Load candidate endpoints ─────────────────────────────────────────────────

const startedAt = Date.now();
console.log('[discover-payees] loading Celo agents from erc8004_agents …');

let agentsLoaded = 0;
let agentsWithEndpoints = 0;
const candidates: Candidate[] = [];

let offset = FROM_OFFSET;
while (agentsLoaded < MAX_AGENTS) {
  const remaining = MAX_AGENTS === Infinity ? PAGE_SIZE : Math.min(PAGE_SIZE, MAX_AGENTS - agentsLoaded);
  if (remaining <= 0) break;
  const page = await listErc8004AgentsPage(CHAIN, offset, remaining);
  if (page.length === 0) break;
  for (const agent of page) {
    agentsLoaded++;
    const eps = endpointsFor(agent);
    if (eps.length === 0) continue;
    agentsWithEndpoints++;
    const selfAddresses = selfAddressesFor(agent);
    for (const endpoint of eps) {
      candidates.push({ agentId: agent.agent_id, selfAddresses, endpoint });
    }
  }
  offset += page.length;
  if (page.length < remaining) break;
}

const sampled = Number.isFinite(MAX_AGENTS) && agentsLoaded >= MAX_AGENTS;
console.log(`[discover-payees] agents loaded:         ${agentsLoaded}${sampled ? ' (SAMPLE — capped by --max-agents)' : ' (full population)'}`);
console.log(`[discover-payees] agents with endpoints: ${agentsWithEndpoints}`);
console.log(`[discover-payees] endpoints to probe:    ${candidates.length}`);
console.log('');

// ─── Probe ────────────────────────────────────────────────────────────────────

let probed = 0;
let got402 = 0;
let ssrfBlocked = 0;
let probeErrors = 0;
const validPayees: Array<{ payee: ExtractedPayee; agentId: number; endpoint: string; verified: boolean }> = [];

/** Probe one candidate; on a real 402 push every extracted Celo payee, tagging
 *  verified = self-payee (payTo controlled by the source agent). */
async function probe(c: Candidate): Promise<void> {
  probed++;
  let res;
  try {
    res = await safeFetchWithStatus(c.endpoint, { timeoutMs: TIMEOUT_MS });
  } catch (err) {
    if (err instanceof SsrfError) ssrfBlocked++;
    else probeErrors++;
    return;
  }
  if (res.status !== 402) return;

  got402++;
  for (const p of extractCeloPayees(res.json)) {
    const verified = c.selfAddresses.has(p.payTo.toLowerCase());
    validPayees.push({ payee: p, agentId: c.agentId, endpoint: c.endpoint, verified });
    console.log(
      `[discover-payees] 402 ✓ agent ${c.agentId}  payTo ${p.payTo}  ${p.token.symbol}  ` +
      `${verified ? 'SELF-PAYEE (verified)' : 'CROSS-ADDRESS (unverified)'}  ${c.endpoint.slice(0, 60)}`,
    );
  }
}

let cursor = 0;
function next(): Candidate | null {
  return cursor < candidates.length ? candidates[cursor++] : null;
}

async function worker() {
  for (;;) {
    const c = next();
    if (!c) return;
    await probe(c);
    if (probed % 100 === 0) {
      console.log(`[discover-payees] … probed ${probed}/${candidates.length} (402s: ${got402}, payees: ${validPayees.length})`);
    }
  }
}

if (candidates.length > 0) {
  console.log(`[discover-payees] probing ${candidates.length} endpoints (concurrency ${CONCURRENCY}) …`);
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
} else {
  console.log('[discover-payees] no HTTP(S) service endpoints declared by any loaded agent — nothing to probe.');
}

// ─── Persist ───────────────────────────────────────────────────────────────────

let written = 0;
if (!DRY_RUN && validPayees.length > 0) {
  for (const v of validPayees) {
    await upsertCeloX402Payee(
      {
        address: v.payee.payTo,
        sourceAgentId: v.agentId,
        endpoint: v.endpoint,
        asset: v.payee.token.address,
        network: v.payee.network,
        verified: v.verified,
      },
      CHAIN,
    );
    written++;
  }
}

// ─── Summary ───────────────────────────────────────────────────────────────────

const selfPayees = validPayees.filter((v) => v.verified);
const crossPayees = validPayees.filter((v) => !v.verified);
const distinctVerified = new Set(selfPayees.map((v) => v.payee.payTo)).size;

console.log('');
console.log('─── summary ──────────────────────────────────────────────');
console.log(`elapsed:                  ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
console.log(`agents loaded:            ${agentsLoaded}${sampled ? '  (SAMPLE)' : '  (full population)'}`);
console.log(`agents with endpoints:    ${agentsWithEndpoints}`);
console.log(`endpoints probed:         ${probed} / ${candidates.length}`);
console.log(`SSRF-blocked endpoints:   ${ssrfBlocked}`);
console.log(`probe errors/timeouts:    ${probeErrors}`);
console.log(`real HTTP 402 responses:  ${got402}`);
console.log(`valid Celo payees found:  ${validPayees.length}  (self ${selfPayees.length}, cross ${crossPayees.length})`);
console.log(`distinct verified payees: ${distinctVerified}`);
console.log(`rows ${DRY_RUN ? 'would write (DRY-RUN)' : 'written            '}: ${DRY_RUN ? validPayees.length : written}`);

if (validPayees.length > 0) {
  console.log('');
  console.log('discovered payees:');
  for (const v of validPayees) {
    console.log(
      `  ${v.verified ? '🟢 verified  ' : '⚪ unverified'} ${v.payee.payTo}  ${v.payee.token.symbol}  ` +
      `agent ${v.agentId}  ${v.payee.network}`,
    );
  }
}

console.log('');
process.exit(0);
