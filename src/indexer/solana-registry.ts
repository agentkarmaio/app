/**
 * Solana (8004-solana) registry → `erc8004_agents` mirror.
 *
 * The fourth and final chain mirror, after Celo/Arc (`erc8004-registry.ts`) and
 * Stellar (`stellar-registry.ts`). Same destination table, same `ScannedAgent`
 * shape, same `upsertErc8004Agents` persistence — only the read path differs.
 *
 * WHY the read path is a paged HTTP API rather than chain reads: 8004-solana
 * ships its own indexer, and `sdk.searchAgents()` returns fully-populated rows
 * (agent_id, asset, owner, agent_wallet, agent_uri, feedback_count,
 * raw_avg_score) 250 at a time, keyless. The alternative, `sdk.getAllAgents()`,
 * is a `getProgramAccounts` call that public RPCs 504 on and that would need a
 * Helius key to buy us nothing.
 *
 * ⚠️ SOLANA IS NOT A REGISTRY-MIRROR CHAIN. `isRegistryMirrorChain()`
 * (`@/lib/chain-meta`) decides whether a chain's CANONICAL agent population is
 * `erc8004_agents` or `wallets`. Solana must stay out of that list: its
 * population is the 94,913 indexed x402 wallets, and this mirror (~1,470 rows)
 * is SUPPLEMENTARY identity data hanging off them. Flipping it would collapse
 * the homepage counter and Explore by ~93k agents. Pinned by a test.
 *
 * The asset pubkey is the load-bearing new field: on Solana the ERC-8004
 * identity is the asset NFT, not the agent_id, and `giveFeedback` cannot be
 * built without it. It rides in `ScannedAgent.assetAddress` →
 * `erc8004_agents.asset_address` (NULL on every other chain).
 */

import type { Erc8004RegistrationStatus } from '@/db/schema';
import { scoreMetadataQuality } from '@/scoring/celo-metadata';
import { decodeRegistration, type ScannedAgent } from './erc8004-registry';
import { withRateLimitRetry, type RateLimitRetryOpts } from '@/lib/rpc-retry';

/** Upstream page cap. `searchAgents` never returns more than this per call. */
export const SOLANA_INDEXER_PAGE_SIZE = 250;

// ─── Reader abstraction ─────────────────────────────────────────────────────

/**
 * The subset of the SDK's `IndexedAgent` this mirror consumes. Declared locally
 * rather than imported so the scan core stays testable without the SDK, and so
 * an upstream field rename surfaces here as a type error instead of silently
 * mapping to undefined.
 *
 * `agent_id` is genuinely optional upstream (the GraphQL backend omits it), and
 * our mirror PK is `(chain, agent_id)` — see `scanSolanaRegistry`.
 */
export interface SolanaIndexedAgent {
  agent_id?: number | string | null;
  asset: string;
  owner: string;
  agent_wallet: string | null;
  agent_uri: string | null;
  feedback_count: number;
  raw_avg_score: number;
}

/** One page of registry rows, injectable so the scan loop needs no network. */
export interface SolanaRegistryReader {
  page(offset: number, limit: number): Promise<SolanaIndexedAgent[]>;
}

/**
 * Live reader over the 8004-solana indexer API. `sdk` is typed structurally so
 * this module never imports the SDK — keeping `@solana/web3.js` out of the
 * bundle graph of anything that only wants the pure scan core.
 */
export function makeSolanaRegistryReader(sdk: {
  searchAgents(params: { limit?: number; offset?: number; orderBy?: string }): Promise<unknown[]>;
}): SolanaRegistryReader {
  return {
    async page(offset, limit) {
      // Stable ordering matters: without it, offset paging over a mutating
      // table can skip rows outright rather than merely repeat them (repeats
      // the scan loop dedupes; skips it cannot detect).
      const rows = await sdk.searchAgents({ limit, offset, orderBy: 'created_at.asc' });
      return rows as SolanaIndexedAgent[];
    },
  };
}

// ─── Mapping ────────────────────────────────────────────────────────────────

export interface MapOpts {
  /** Fetch http(s)/ipfs registrations. Off = mark 'pending' for a fast pass. */
  fetchRemote?: boolean;
  timeoutMs?: number;
}

/**
 * `agent_id` → number, or null when it is absent or not numeric. Never NaN and
 * never a 0 default: the PK is `(chain, agent_id)`, so a fabricated id would
 * collide every unidentifiable agent onto one row.
 */
export function parseAgentId(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Project one indexed row into the `ScannedAgent` shape `upsertErc8004Agents`
 * persists. Pure apart from the registration fetch, which `decodeRegistration`
 * performs (and SSRF-guards).
 *
 * Callers must have resolved `agent_id` already — `scanSolanaRegistry` filters
 * unidentifiable rows out before this point.
 */
export async function mapSolanaAgentToScanned(
  row: SolanaIndexedAgent,
  opts: MapOpts = {},
): Promise<ScannedAgent> {
  const { registration, status } = await decodeRegistration(row.agent_uri, {
    fetchRemote: opts.fetchRemote ?? true,
    timeoutMs: opts.timeoutMs ?? 8000,
  });
  const registrationStatus: Erc8004RegistrationStatus = status;

  // tokenURI is load-bearing, not decoration: the rubric's 10-point
  // `tamperResistance` dimension checks whether the pointer is content-addressed
  // (data:/ipfs:/ar:) rather than a mutable https URL. Omitting it silently
  // under-scores every inline agent by 10.
  const metadataScore = scoreMetadataQuality({
    registration,
    tokenURI: row.agent_uri ?? undefined,
  }).score;

  const count = row.feedback_count ?? 0;
  const avg = count > 0 ? row.raw_avg_score : null;

  return {
    // Non-null by construction — scanSolanaRegistry drops rows without an id.
    agentId: parseAgentId(row.agent_id)!,
    owner: row.owner,
    // No zero-address sentinel on Solana: an unset wallet is null, and the
    // agent's effective operator IS the owner (same rule as Stellar).
    agentWallet: row.agent_wallet ?? row.owner,
    assetAddress: row.asset,
    tokenURI: row.agent_uri || null,
    registration,
    registrationStatus,
    metadataScore,
    feedback: { count, sum: avg === null ? null : avg * count, avg },
  };
}

// ─── Scan loop ──────────────────────────────────────────────────────────────

export interface ScanSolanaOpts extends MapOpts, RateLimitRetryOpts {
  reader: SolanaRegistryReader;
  /** Rows per request. Capped at the upstream 250. */
  pageSize?: number;
  /** First row offset — resume point for a partial sweep. */
  fromOffset?: number;
  /** Stop after this many mapped agents. Default: the whole registry. */
  maxAgents?: number;
  /** Called after each page with the running mapped-agent total. */
  onProgress?: (total: number, offset: number) => void;
}

export interface ScanSolanaResult {
  agents: ScannedAgent[];
  pagesFetched: number;
  /** Rows the upstream served without a usable `agent_id` — unpersistable. */
  skippedNoAgentId: number;
  /** Ids re-served across pages (upstream offset drift), collapsed to one row. */
  duplicates: number;
  errors: Array<{ offset: number; error: string }>;
}

/**
 * Page the registry until it runs dry (a short or empty page), the `maxAgents`
 * cap is hit, or a page fails past its retries.
 *
 * A failing page is recorded and the sweep MOVES ON to the next offset rather
 * than aborting: one 503 in the middle of ~1,470 rows should cost that page,
 * not the run. Every such gap is reported in `errors` so a partial sweep never
 * reads as a complete one.
 */
export async function scanSolanaRegistry(opts: ScanSolanaOpts): Promise<ScanSolanaResult> {
  const {
    reader,
    pageSize = SOLANA_INDEXER_PAGE_SIZE,
    fromOffset = 0,
    maxAgents = Infinity,
    onProgress,
  } = opts;
  const limit = Math.min(Math.max(1, pageSize), SOLANA_INDEXER_PAGE_SIZE);
  const retryOpts: RateLimitRetryOpts = {
    retries: opts.retries,
    baseMs: opts.baseMs,
    jitter: opts.jitter,
  };

  const agents: ScannedAgent[] = [];
  const errors: Array<{ offset: number; error: string }> = [];
  const seen = new Set<number>();
  let skippedNoAgentId = 0;
  let duplicates = 0;
  let pagesFetched = 0;
  let offset = fromOffset;

  for (;;) {
    if (agents.length >= maxAgents) break;

    let rows: SolanaIndexedAgent[];
    try {
      rows = await withRateLimitRetry(() => reader.page(offset, limit), retryOpts);
    } catch (err) {
      errors.push({ offset, error: err instanceof Error ? err.message : String(err) });
      pagesFetched++;
      offset += limit;
      continue;
    }

    pagesFetched++;

    for (const row of rows) {
      if (agents.length >= maxAgents) break;
      const agentId = parseAgentId(row.agent_id);
      if (agentId === null) {
        skippedNoAgentId++;
        continue;
      }
      if (seen.has(agentId)) {
        duplicates++;
        continue;
      }
      seen.add(agentId);
      agents.push(await mapSolanaAgentToScanned(row, opts));
    }

    onProgress?.(agents.length, offset);
    offset += limit;

    // A page shorter than the limit means the registry is exhausted. A
    // full-length final page is followed by one empty page, which lands here
    // with rows.length === 0 and ends the sweep the same way.
    if (rows.length < limit) break;
  }

  agents.sort((a, b) => a.agentId - b.agentId);
  return { agents, pagesFetched, skippedNoAgentId, duplicates, errors };
}
