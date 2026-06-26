/**
 * Karma DB Client -- Supabase
 *
 * Env vars required:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  Wallet, Transaction, TrustTier, IndexerCursor, Feedback, FeedbackRating, LivenessStatus,
  ConfidenceBadge, SignalEvent, SignalTier, KarmaFace, AutonomyLabel,
  AgentManifest, ManifestSourceType, ParsedManifest,
  Organization, OrganizationMember, WalletScanState,
  Chain, Succession, SuccessionStatus, SuccessionSourceType, SuccessionHeir,
  Bond, BondUnderwriter, BondStatus,
} from './schema';
// Type-only: erased at runtime, so this does NOT pull viem/the scanner into the
// db-client bundle that API routes + the Docker build load.
import type { ScannedAgent, ScannedFeedback } from '@/indexer/erc8004-registry';
// Pure tier-from-score helper (scoring/index imports only types from schema, so
// no runtime cycle). Used to derive trust_tier for registry-mirror rows.
import { getTrustTier } from '@/scoring/index';
// Viem-free constants only — keeps the EVM write path's viem deps out of this
// server DB bundle. Used by getAkConnectedFeedback (the /celo "feedback AK made"
// list) to scope the mirror read to AK's schemes + rater wallets.
import { AK_RATER_ADDRESSES, AK_METADATA_TAG1, AK_REVIEW_TAG1 } from '@/config/ak-validator';

// Every DB helper that takes a wallet address optionally takes a chain. The
// default is 'solana' for back-compat with all pre-existing callers — Solana
// is what the DB held until 0004_multichain.sql. NEW Celo paths must pass
// `'celo'` explicitly. Composite-PK enforcement happens at the schema layer,
// so a missing chain doesn't corrupt data — it just resolves to Solana rows.
const DEFAULT_CHAIN: Chain = 'solana';

// Max addresses per `.in('address', [...])` filter. PostgREST encodes the list
// into the request URL (`?address=in.(a,b,…)`); base58 Solana addresses are ~44
// chars each, so a list beyond ~170 overflows Kong's ~8KB URI cap → a hard
// "URI too long" error. 100 keeps every address-list query comfortably under it
// (100 × ~47 ≈ 4.7KB). Chunk EVERY address-keyed `.in()` to this bound.
export const ADDRESS_IN_CHUNK = 100;

// Tighter bound for tx_signature `.in()` lists: base58 Solana signatures are
// ~88 chars (≈2× an address), so the same 100-row chunk would approach the URI
// cap. 60 × ~90 ≈ 5.4KB stays safe.
export const SIGNATURE_IN_CHUNK = 60;

// --- Supabase Client ---------------------------------------------------------
// Lazy: only instantiated on first access. Keeps `next build` from crashing
// when env vars aren't present during the Docker build step.

let _client: SupabaseClient | null = null;

// Test seam: lets unit tests inject a fake Supabase without a live connection.
// Production code always goes through getSupabase()/the proxy below.
let _testClient: SupabaseClient | null = null;
export function __setSupabaseForTest(client: unknown): void {
  _testClient = client as SupabaseClient;
}

function getSupabase(): SupabaseClient {
  if (_testClient) return _testClient;
  if (_client) return _client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  _client = createClient(url, key);
  return _client;
}

export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = getSupabase();
    const value = Reflect.get(client, prop, client);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

// --- Wallet Queries ----------------------------------------------------------

export async function getWallet(address: string, chain: Chain = DEFAULT_CHAIN): Promise<Wallet | null> {
  const { data, error } = await supabase
    .from('wallets')
    .select('*')
    .eq('chain', chain)
    .eq('address', address)
    .single();

  if (error && error.code === 'PGRST116') return null;
  if (error) throw error;
  return data as Wallet;
}

/**
 * Look up every wallet row matching `address` across ANY chain. Used by the
 * agent detail page when the URL doesn't pin a chain — Solana/Stellar can be
 * narrowed from address format but Celo and Arc share the EVM 0x…40hex format,
 * so a single EVM address can map to up to two rows (one per chain) which the
 * caller must disambiguate (UI selector, default rules). Returns rows ordered
 * by `chain` for deterministic UI rendering. Indexed by `idx_wallets_address`.
 */
export async function getWalletsByAddressAnyChain(address: string): Promise<Wallet[]> {
  const { data, error } = await supabase
    .from('wallets')
    .select('*')
    .eq('address', address)
    .order('chain', { ascending: true });

  if (error) throw error;
  return (data ?? []) as Wallet[];
}

export interface UpsertWalletOpts {
  providerScore?: number;
  consumerScore?: number | null;
  confidenceBadge?: ConfidenceBadge;
  autonomyScore?: number | null;
  autonomyLabel?: AutonomyLabel | null;
  // Denormalized Tier-2 metrics for Explore table filtering/sort.
  metricSuccessRate?: number | null;
  metricDiversity?: number | null;
  metricVolume?: number | null;
  metricAge?: number | null;
  metricCadence?: number | null;
}

export async function upsertWallet(
  address: string,
  score: number,
  trustTier: TrustTier,
  txCount: number,
  opts: UpsertWalletOpts = {},
  chain: Chain = DEFAULT_CHAIN,
): Promise<void> {
  // Back-compat: when Phase-F fields aren't supplied, mirror `score` into
  // `provider_score` and default the badge to 'declared'.
  const providerScore = opts.providerScore ?? score;
  const confidenceBadge: ConfidenceBadge = opts.confidenceBadge ?? 'declared';

  const row: Record<string, unknown> = {
    chain,
    address,
    score,
    provider_score: providerScore,
    confidence_badge: confidenceBadge,
    trust_tier: trustTier,
    tx_count: txCount,
    last_seen: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if ('consumerScore' in opts) row.consumer_score = opts.consumerScore;
  if ('autonomyScore' in opts) row.autonomy_score = opts.autonomyScore;
  if ('autonomyLabel' in opts) row.autonomy_label = opts.autonomyLabel;
  if ('metricSuccessRate' in opts) row.metric_success_rate = opts.metricSuccessRate;
  if ('metricDiversity' in opts)   row.metric_diversity    = opts.metricDiversity;
  if ('metricVolume' in opts)      row.metric_volume       = opts.metricVolume;
  if ('metricAge' in opts)         row.metric_age          = opts.metricAge;
  if ('metricCadence' in opts)     row.metric_cadence      = opts.metricCadence;

  const { error } = await supabase
    .from('wallets')
    .upsert(row, { onConflict: 'chain,address' });

  if (error) throw error;
}

export interface LeaderboardFilters {
  status?: LivenessStatus;
  tier?: TrustTier;
  chain?: Chain;
}

export interface LeaderboardPage {
  wallets: Wallet[];
  total: number;
}

export async function getLeaderboard(
  limit = 25,
  offset = 0,
  filters: LeaderboardFilters = {},
  opts: { withCount?: boolean } = {},
): Promise<LeaderboardPage> {
  // count: 'exact' over 86k+ wallets is the slow path. Skip when caller doesn't
  // need the total (e.g. homepage cache, where only the page rows are used).
  const withCount = opts.withCount ?? true;
  let q = supabase
    .from('wallets')
    .select('*', withCount ? { count: 'exact' } : {})
    .gt('score', 0);

  if (filters.chain) q = q.eq('chain', filters.chain);

  if (filters.tier) q = q.eq('trust_tier', filters.tier);

  if (filters.status) {
    const now = Date.now();
    const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3600_000).toISOString();
    switch (filters.status) {
      case 'Active':
        q = q.gte('last_seen', iso(24));
        break;
      case 'Recent':
        q = q.lt('last_seen', iso(24)).gte('last_seen', iso(7 * 24));
        break;
      case 'Dormant':
        q = q.lt('last_seen', iso(7 * 24)).gte('last_seen', iso(90 * 24));
        break;
      case 'Inactive':
        q = q.lt('last_seen', iso(90 * 24));
        break;
    }
  }

  const { data, error, count } = await q
    .order('score', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return { wallets: (data ?? []) as Wallet[], total: count ?? 0 };
}

// --- Agents Explorer ---------------------------------------------------------
//
// Powers the /explore Agents tab. Richer than getLeaderboard — filters +
// multi-field sort + pagination on denormalized Tier-2 metrics. All sortable
// columns are indexed (see schema.ts) so large-fleet queries stay cheap.

export type AgentSortField =
  | 'provider_score' | 'consumer_score' | 'tx_count' | 'last_seen'
  | 'autonomy_score' | 'metric_cadence' | 'metric_success_rate'
  | 'metric_diversity' | 'metric_volume' | 'metric_age';

export interface AgentsExploreFilters {
  tiers?: TrustTier[];
  confidenceBadges?: ConfidenceBadge[];
  autonomyLabels?: AutonomyLabel[];
  status?: LivenessStatus;
  claimed?: boolean;
  chain?: Chain;            // restrict to a single chain; omitted = all chains
  minProviderScore?: number;
  minCadence?: number;
  minDiversity?: number;
  minSuccessRate?: number;
  search?: string;          // substring match on address/display_name
}

export interface AgentsExploreSort {
  field: AgentSortField;
  direction: 'asc' | 'desc';
}

// Trust-tier → metadata_score band (inverse of getTrustTier). Used to translate
// the explore tier-chip filter into a PostgREST score-range query for registry
// rows, which have no stored trust_tier column.
const TIER_SCORE_BAND: Record<TrustTier, [number, number]> = {
  Unrated:     [0, 20],
  Poor:        [21, 40],
  Fair:        [41, 60],
  Good:        [61, 75],
  'Very Good': [76, 90],
  Excellent:   [91, 100],
};

/** Map an erc8004_agents row into the Wallet shape the leaderboard renders.
 *  The agent's on-chain identity is the agent_id; address carries the agent
 *  wallet (or owner) for display + the existing /agent link, and the
 *  chain-specific agentId column lets the agent page resolve the profile. */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function registryRowToWallet(row: Record<string, unknown>, chain: Chain): Wallet {
  const score = Number(row.metadata_score ?? 0);
  const reg = (row.registration ?? null) as { name?: string; description?: string; image?: string } | null;
  // getAgentWallet() returns the zero address when an agent never set a custom
  // wallet — its effective operator IS the owner. Fall back so we never surface
  // 0x000…000 as the agent's address.
  const aw = row.agent_wallet as string | null;
  const address = aw && aw.toLowerCase() !== ZERO_ADDRESS ? aw : (row.owner as string);
  const indexedAt = (row.last_indexed_at as string) ?? new Date().toISOString();
  const agentId = Number(row.agent_id);
  return {
    chain,
    address,
    first_seen: (row.first_indexed_at as string) ?? indexedAt,
    last_seen: indexedAt,
    tx_count: 0,
    score,
    trust_tier: getTrustTier(score),
    updated_at: indexedAt,
    claimed: false,
    display_name: reg?.name ?? null,
    image_url: reg?.image ?? null,
    description: reg?.description ?? null,
    provider_score: score,
    consumer_score: null,
    confidence_badge: 'declared',
    autonomy_score: null,
    autonomy_label: null,
    celo_agent_id: chain === 'celo' ? agentId : null,
    arc_agent_id: chain === 'arc' ? agentId : null,
  } as Wallet;
}

/**
 * Leaderboard page sourced from the ERC-8004 registry mirror (erc8004_agents),
 * not `wallets`. EVM 8004 chains (Celo/Arc) register agents as NFTs — a single
 * owner controls many — so the address-keyed `wallets` table can't represent
 * the true per-agent population. This reads one row per agent_id so the explore
 * count + list match 8004scan. Filters that don't apply to declared-only
 * registry rows (autonomy, Tier-2 metrics) short-circuit to empty when set.
 */
async function getRegistryAgentsPage(
  chain: Chain,
  limit: number,
  offset: number,
  filters: AgentsExploreFilters,
  sort: AgentsExploreSort,
): Promise<LeaderboardPage> {
  // Registry rows are Tier-3 declared only. A confidence filter that excludes
  // 'declared', any autonomy-label filter, or a Tier-2 metric threshold can
  // never match → return empty rather than a misleading full list.
  if (filters.confidenceBadges?.length && !filters.confidenceBadges.includes('declared')) {
    return { wallets: [], total: 0 };
  }
  if (filters.autonomyLabels?.length) return { wallets: [], total: 0 };
  if (filters.minCadence != null || filters.minDiversity != null || filters.minSuccessRate != null) {
    return { wallets: [], total: 0 };
  }

  let q = supabase
    .from('erc8004_agents')
    .select('*', { count: 'exact' })
    .eq('chain', chain);

  if (filters.minProviderScore != null) q = q.gte('metadata_score', filters.minProviderScore);

  if (filters.tiers?.length) {
    // OR of per-tier score bands → e.g. or(and(metadata_score.gte.0,...lte.20),…).
    const groups = filters.tiers.map((t) => {
      const [lo, hi] = TIER_SCORE_BAND[t];
      return `and(metadata_score.gte.${lo},metadata_score.lte.${hi})`;
    });
    q = q.or(groups.join(','));
  }

  if (filters.search) {
    const term = escapeSearchTerm(filters.search);
    if (term) q = q.or(`owner.ilike.%${term}%,agent_wallet.ilike.%${term}%`);
  }

  // Sort: map the wallet-oriented sort fields onto registry columns. Unmappable
  // fields fall back to metadata_score (the registry's headline metric).
  const col =
    sort.field === 'last_seen' ? 'last_indexed_at'
    : sort.field === 'tx_count' ? 'feedback_count'
    : 'metadata_score';
  const { data, error, count } = await q
    .order(col, { ascending: sort.direction === 'asc', nullsFirst: false })
    .order('agent_id', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  const wallets = ((data ?? []) as Record<string, unknown>[]).map((r) => registryRowToWallet(r, chain));
  return { wallets, total: count ?? 0 };
}

/**
 * "All chains" leaderboard page — queries the `explore_agents` view, which
 * unions Solana/Stellar `wallets` (score-gated) with the Celo/Arc registry
 * mirror (per-agent). This is what makes the unfiltered explore count include
 * the real 8004 agent population instead of the handful of owner rows. The view
 * bakes in the wallets-side score>0 gate, so no extra gate is applied here.
 */
async function getUnifiedAgentsPage(
  limit: number,
  offset: number,
  filters: AgentsExploreFilters,
  sort: AgentsExploreSort,
): Promise<LeaderboardPage> {
  let q = supabase.from('explore_agents').select('*', { count: 'exact' });

  if (filters.tiers?.length) q = q.in('trust_tier', filters.tiers);
  if (filters.confidenceBadges?.length) q = q.in('confidence_badge', filters.confidenceBadges);
  if (filters.autonomyLabels?.length) q = q.in('autonomy_label', filters.autonomyLabels);
  if (filters.claimed != null) q = q.eq('claimed', filters.claimed);
  if (filters.minProviderScore != null) q = q.gte('provider_score', filters.minProviderScore);
  if (filters.minCadence != null) q = q.gte('metric_cadence', filters.minCadence);
  if (filters.minDiversity != null) q = q.gte('metric_diversity', filters.minDiversity);
  if (filters.minSuccessRate != null) q = q.gte('metric_success_rate', filters.minSuccessRate);

  if (filters.status) {
    const now = Date.now();
    const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3600_000).toISOString();
    switch (filters.status) {
      case 'Active':   q = q.gte('last_seen', iso(24)); break;
      case 'Recent':   q = q.lt('last_seen', iso(24)).gte('last_seen', iso(7 * 24)); break;
      case 'Dormant':  q = q.lt('last_seen', iso(7 * 24)).gte('last_seen', iso(90 * 24)); break;
      case 'Inactive': q = q.lt('last_seen', iso(90 * 24)); break;
    }
  }

  if (filters.search) {
    const term = escapeSearchTerm(filters.search);
    if (term) q = q.or(`address.ilike.%${term}%,display_name.ilike.%${term}%`);
  }

  const { data, error, count } = await q
    .order(sort.field, { ascending: sort.direction === 'asc', nullsFirst: false })
    .order('address', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return { wallets: (data ?? []) as Wallet[], total: count ?? 0 };
}

export async function getAgents(
  limit = 25,
  offset = 0,
  filters: AgentsExploreFilters = {},
  sort: AgentsExploreSort = { field: 'provider_score', direction: 'desc' },
): Promise<LeaderboardPage> {
  // EVM 8004 chains read the registry mirror (per-agent), not the owner-keyed
  // `wallets` table — see getRegistryAgentsPage. Solana/Stellar fall through.
  //
  // Exception: claimed=true. Claims land in `wallets` (claimWallet), never in
  // the registry mirror — every registry row maps to claimed:false. Routing a
  // claimed=true query to the registry would ignore the filter and return the
  // entire declared-only population. So claimed=true always reads `wallets`,
  // even for celo/arc. (claimed=false keeps reading the registry: it is the
  // full unclaimed population; the handful of claimed rows that also live in
  // wallets are an accepted, marginal overcount there.)
  if ((filters.chain === 'celo' || filters.chain === 'arc') && filters.claimed !== true) {
    return getRegistryAgentsPage(filters.chain, limit, offset, filters, sort);
  }
  // "All chains" (no chain filter) unions wallets + the registry mirror via the
  // `explore_agents` view so the count + list reflect every agent, not just the
  // owner rows. claimed=true is the same exception as above — claims live only
  // in `wallets`, and the view drops celo/arc wallet rows — so it falls through
  // to the wallets path below, which spans all chains.
  if (filters.chain == null && filters.claimed !== true) {
    return getUnifiedAgentsPage(limit, offset, filters, sort);
  }

  // Score > 0 gate matches getLeaderboard semantics. Previously this was
  // tx_count > 0 which excluded Celo/Stellar/Arc rows whose only signal is
  // Tier-3 metadata_quality (no indexed transactions). Solana rows with
  // tx_count > 0 always carry score > 0, so this doesn't regress them.
  let q = supabase
    .from('wallets')
    .select('*', { count: 'exact' });

  // The score>0 gate hides untracked/noise wallets from the default population.
  // When the caller explicitly filters for claimed agents, drop it: a freshly
  // claimed agent is inserted score:0 until the scorer runs, and its owner still
  // expects it under the claimed filter.
  if (filters.claimed !== true) q = q.gt('score', 0);

  if (filters.chain) q = q.eq('chain', filters.chain);
  if (filters.tiers?.length) q = q.in('trust_tier', filters.tiers);
  if (filters.confidenceBadges?.length) q = q.in('confidence_badge', filters.confidenceBadges);
  if (filters.autonomyLabels?.length) q = q.in('autonomy_label', filters.autonomyLabels);
  if (filters.claimed != null) q = q.eq('claimed', filters.claimed);
  if (filters.minProviderScore != null) q = q.gte('provider_score', filters.minProviderScore);
  if (filters.minCadence != null) q = q.gte('metric_cadence', filters.minCadence);
  if (filters.minDiversity != null) q = q.gte('metric_diversity', filters.minDiversity);
  if (filters.minSuccessRate != null) q = q.gte('metric_success_rate', filters.minSuccessRate);

  if (filters.status) {
    const now = Date.now();
    const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3600_000).toISOString();
    switch (filters.status) {
      case 'Active':   q = q.gte('last_seen', iso(24)); break;
      case 'Recent':   q = q.lt('last_seen', iso(24)).gte('last_seen', iso(7 * 24)); break;
      case 'Dormant':  q = q.lt('last_seen', iso(7 * 24)).gte('last_seen', iso(90 * 24)); break;
      case 'Inactive': q = q.lt('last_seen', iso(90 * 24)); break;
    }
  }

  if (filters.search) {
    // escapeSearchTerm also strips commas/parens that would otherwise break the
    // PostgREST .or() grammar (the old `[%_]`-only strip left that gap open).
    const term = escapeSearchTerm(filters.search);
    if (term) q = q.or(`address.ilike.%${term}%,display_name.ilike.%${term}%`);
  }

  // Sort with a stable tiebreaker on address so pagination is deterministic.
  const { data, error, count } = await q
    .order(sort.field, { ascending: sort.direction === 'asc', nullsFirst: false })
    .order('address', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return { wallets: (data ?? []) as Wallet[], total: count ?? 0 };
}

// --- Wallet Search (address OR name) -----------------------------------------

/**
 * Escape a user-supplied search term for safe interpolation into a PostgREST
 * `.or()` ilike filter. The or-filter grammar treats `,` as a condition
 * separator and `(` `)` as grouping; `%` `_` are ilike wildcards. We replace
 * all of them with spaces so the term is matched as a literal substring and a
 * crafted query (e.g. `a,address.ilike.*`) cannot inject extra filter
 * conditions. Returns a collapsed, trimmed string ('' when nothing usable).
 */
export function escapeSearchTerm(raw: string): string {
  return raw.replace(/[%_(),*]/g, ' ').replace(/\s+/g, ' ').trim();
}

// The wallets-table column that carries a chain's ERC-8004 agentId. Single
// source of truth so the search filter and the (chain, agentId) resolver can't
// drift. Solana isn't ERC-8004 and has no agentId column → absent from the map.
type AgentIdColumn = 'celo_agent_id' | 'arc_agent_id' | 'stellar_agent_id';
const AGENT_ID_COLUMN: Partial<Record<Chain, AgentIdColumn>> = {
  celo: 'celo_agent_id',
  arc: 'arc_agent_id',
  stellar: 'stellar_agent_id',
};
const ALL_AGENT_ID_COLUMNS = Object.values(AGENT_ID_COLUMN) as AgentIdColumn[];
// wallets.*_agent_id are int32; a query outside that range can't match any row,
// so we skip the eq clause rather than send a literal the DB would reject.
const MAX_INT32 = 2147483647;
function agentIdColumn(chain: Chain): AgentIdColumn | null {
  return AGENT_ID_COLUMN[chain] ?? null;
}

export interface WalletSearchRow {
  address: string;
  chain: Chain;
  displayName: string | null;
  score: number;
  trustTier: TrustTier;
  txCount: number;
  /** ERC-8004 agentId on this row's chain, when materialized. null for Solana
   *  and for EVM/Stellar agents not yet bound to an id. Lets callers render the
   *  id and build a precise /agent link. */
  agentId: number | null;
}

/**
 * Search wallets by address OR display_name substring (case-insensitive). A
 * purely-numeric query additionally matches an exact ERC-8004 agentId across the
 * per-chain agentId columns, so typing `9058` surfaces Celo agent #9058. Ranked
 * by score descending. Returns the chain + matched agentId so callers can render
 * a chain badge and build a chain-aware /agent link. Powers the homepage search
 * box and the MCP `search_agents` tool — one place for the escaping + name logic.
 */
export async function searchWallets(query: string, limit = 8): Promise<WalletSearchRow[]> {
  const term = escapeSearchTerm(query);
  if (term.length < 3) return [];

  // Numeric query → also match an exact agentId. Sub-3-char ids stay resolver-only
  // (GET /api/v2/agent/[chain]/[id]); search keeps the 3-char floor to avoid noisy
  // substring scans.
  const asId = /^\d+$/.test(term) ? Number(term) : NaN;
  const idClauses =
    Number.isSafeInteger(asId) && asId >= 0 && asId <= MAX_INT32
      ? ALL_AGENT_ID_COLUMNS.map((c) => `${c}.eq.${asId}`)
      : [];
  const orFilter = [
    `address.ilike.%${term}%`,
    `display_name.ilike.%${term}%`,
    ...idClauses,
  ].join(',');

  const { data, error } = await supabase
    .from('wallets')
    .select('address, chain, display_name, score, trust_tier, tx_count, celo_agent_id, arc_agent_id, stellar_agent_id')
    .or(orFilter)
    .order('score', { ascending: false })
    .limit(Math.max(1, Math.min(50, limit)));

  if (error) throw error;

  return ((data ?? []) as Array<{
    address: string; chain: Chain; display_name: string | null;
    score: number; trust_tier: TrustTier; tx_count: number;
    celo_agent_id: number | null; arc_agent_id: number | null; stellar_agent_id: number | null;
  }>).map((w) => {
    const col = agentIdColumn(w.chain);
    return {
      address: w.address,
      chain: w.chain,
      displayName: w.display_name,
      score: Number(w.score),
      trustTier: w.trust_tier,
      txCount: w.tx_count,
      agentId: col ? (w[col] ?? null) : null,
    };
  });
}

/**
 * Resolve a single wallet by its ERC-8004 agentId on one chain. Powers the
 * GET /api/v2/agent/[chain]/[id] deep-link / SDK resolver. Returns null (not an
 * error) for Solana (no agentId), out-of-range ids, and unknown ids. The
 * agentId columns aren't UNIQUE (an owner may rotate ids), so we take the
 * highest-scored match deterministically rather than risk a multi-row throw.
 */
export async function getWalletByAgentId(chain: Chain, agentId: number): Promise<Wallet | null> {
  const col = agentIdColumn(chain);
  if (!col || !Number.isInteger(agentId) || agentId < 0 || agentId > MAX_INT32) return null;

  const { data, error } = await supabase
    .from('wallets')
    .select('*')
    .eq('chain', chain)
    .eq(col, agentId)
    .order('score', { ascending: false })
    .limit(1);

  if (error) throw error;
  return ((data ?? [])[0] as Wallet) ?? null;
}

// --- ERC-8004 Rater Resolution -----------------------------------------------
//
// A ReputationRegistry feedback record's `client` is just an address. When AK
// already knows that address — as a claimed wallet or an indexed registry agent
// — the feedback list surfaces its name + a link to its AK profile instead of a
// bare hex string. Resolution is best-effort and additive: an unresolved rater
// stays a plain address.

export interface RaterInfo {
  /** Display name: claimed wallet name preferred, else registry registration name. */
  name: string | null;
  /**
   * The rater's own agent_id on this chain, when it is itself a registered agent
   * (matched by agent_wallet, which is 1:1 with an agent_id). Lets the caller
   * build a precise /agent link. null when only a claimed-wallet match exists.
   */
  agentId: number | null;
}

/**
 * Resolve ERC-8004 feedback rater addresses to a name + agent_id for one EVM
 * chain. Two best-effort lookups, merged into one Map:
 *   - `erc8004_agents`: a rater that is itself a registered agent, matched by
 *     agent_wallet (1:1 → a precise agent_id + its registration name). Owner
 *     matches are intentionally NOT resolved — one owner controls many agents,
 *     so an owner address can't map to a single profile without misattribution.
 *   - `wallets`: a claimed rater carries a curated display_name, which takes
 *     precedence over the on-chain registration name.
 * Only addresses we can attach a name OR an agent_id to enter the Map; a bare
 * `wallets` row with no display_name adds no signal and is skipped. Addresses
 * are lowercased to match the stored (lowercase) EVM convention, and the Map is
 * keyed by the lowercased address. Absent key = unknown rater.
 */
export async function resolveRaters(
  addresses: string[],
  chain: 'celo' | 'arc',
): Promise<Map<string, RaterInfo>> {
  const out = new Map<string, RaterInfo>();
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))];
  if (unique.length === 0) return out;

  // Chunk to stay under Kong's ~8KB URI cap on .in() filters (ADDRESS_IN_CHUNK).
  for (let i = 0; i < unique.length; i += ADDRESS_IN_CHUNK) {
    const chunk = unique.slice(i, i + ADDRESS_IN_CHUNK);

    const [agentsRes, walletsRes] = await Promise.all([
      supabase
        .from('erc8004_agents')
        .select('agent_id, agent_wallet, registration')
        .eq('chain', chain)
        .in('agent_wallet', chunk),
      supabase
        .from('wallets')
        .select('address, display_name')
        .eq('chain', chain)
        .in('address', chunk),
    ]);

    if (agentsRes.error) throw agentsRes.error;
    if (walletsRes.error) throw walletsRes.error;

    // Registry first (always carries an agent_id); a curated wallet name layers
    // on top below without dropping the agent_id.
    for (const row of (agentsRes.data ?? []) as Array<{
      agent_id: number; agent_wallet: string | null; registration: { name?: string } | null;
    }>) {
      const addr = row.agent_wallet?.toLowerCase();
      if (!addr) continue;
      out.set(addr, { name: row.registration?.name ?? null, agentId: Number(row.agent_id) });
    }
    for (const row of (walletsRes.data ?? []) as Array<{ address: string; display_name: string | null }>) {
      if (!row.display_name) continue; // only a curated name adds signal
      const addr = row.address.toLowerCase();
      out.set(addr, { name: row.display_name, agentId: out.get(addr)?.agentId ?? null });
    }
  }

  return out;
}

// --- Agent Claiming ----------------------------------------------------------

export async function claimWallet(
  address: string,
  displayName: string,
  description: string | null,
  website: string | null,
  category: string | null,
  tempoAddress: string | null = null,
  chain: Chain = DEFAULT_CHAIN,
  /**
   * Off-chain proof of ownership (signature + signed challenge). Persisted so
   * the agent page can render a re-verifiable receipt. Spread conditionally:
   * a proof-less claim (seed scripts, legacy callers) must NEVER overwrite an
   * existing stored proof with null.
   */
  proof: { signature: string; message: string } | null = null,
  /**
   * User-supplied logo URL (http(s)). Null-safe like `proof`: a blank claim form
   * must NEVER wipe a logo the registry mirror previously denormalized into
   * image_url. The edit route uses `updateClaimedAgentMetadata` for the
   * full-replace path that CAN clear it.
   */
  imageUrl: string | null = null,
): Promise<void> {
  const proofFields = proof
    ? { claim_signature: proof.signature, claim_message: proof.message }
    : {};
  const imageFields = imageUrl ? { image_url: imageUrl } : {};

  // Ensure the wallet row exists (upsert with minimal data if not). Lookup is
  // chain-scoped so a Stellar claim never matches a Solana row under the same
  // string and vice-versa — (chain,address) is the composite PK.
  const existing = await getWallet(address, chain);
  if (!existing) {
    const { error: insertErr } = await supabase
      .from('wallets')
      .insert({
        chain,
        address,
        score: 0,
        trust_tier: 'Unrated',
        tx_count: 0,
        claimed: true,
        display_name: displayName,
        description,
        website,
        category,
        tempo_address: tempoAddress,
        ...proofFields,
        ...imageFields,
        claimed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    if (insertErr) throw insertErr;
    return;
  }

  const { error } = await supabase
    .from('wallets')
    .update({
      chain,
      claimed: true,
      display_name: displayName,
      description,
      website,
      category,
      tempo_address: tempoAddress,
      ...proofFields,
      ...imageFields,
      claimed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('chain', chain)
    .eq('address', address);

  if (error) throw error;
}

/**
 * Attach an off-chain ownership proof (signature + signed challenge) to an
 * EXISTING wallet row WITHOUT touching identity metadata. Backs the
 * prove-ownership upgrade for already-claimed agents whose original claim-time
 * signature was never retained. Marks claimed=true defensively and stamps
 * claimed_at only if it was never set. Chain-scoped on the composite PK.
 *
 * Returns false when no row matched (nothing to attach the proof to).
 */
export async function setClaimProof(
  address: string,
  chain: Chain,
  proof: { signature: string; message: string },
): Promise<boolean> {
  const existing = await getWallet(address, chain);
  if (!existing) return false;

  const { error } = await supabase
    .from('wallets')
    .update({
      claimed: true,
      claim_signature: proof.signature,
      claim_message: proof.message,
      claimed_at: existing.claimed_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('chain', chain)
    .eq('address', address);

  if (error) throw error;
  return true;
}

/**
 * Full-replace update of an ALREADY-CLAIMED agent's identity metadata, backing
 * the /api/agent/edit route. Distinct from `claimWallet` (an upsert that flips
 * claimed=true, stamps claimed_at, and carries the Solana claim's
 * succession/scan side-effects) — this is UPDATE-only on an existing CLAIMED
 * row and touches ONLY the editable fields.
 *
 * Full-replace, not null-safe: a field passed as `null` CLEARS it (the form is
 * pre-filled with current values, so a blank field is an explicit clear). Empty
 * logo input must reach here as `null`, never `''` — see `validateImageUrl`.
 * `tempoAddress` is the one exception: `undefined` leaves it unchanged (the
 * non-Solana edit forms omit the field entirely).
 *
 * Deliberately does NOT write claim_signature / claim_message: the edit
 * signature is operation-scoped ("Edit wallet …") and must never be persisted to
 * the publicly-displayed claim receipt, or it would become a replayable
 * edit-authorizer. Refreshing the claim proof is the dedicated /api/agent/prove
 * route's job. Also never touches claimed / claimed_at / score / succession /
 * scan state.
 *
 * Returns a discriminated result so the route can distinguish 404 (no row) from
 * 409 (row exists but isn't claimed — claim it first).
 */
export async function updateClaimedAgentMetadata(
  address: string,
  chain: Chain,
  fields: {
    displayName: string;
    description: string | null;
    website: string | null;
    category: string | null;
    imageUrl: string | null;
    /** undefined → leave tempo_address unchanged (non-Solana forms omit it). */
    tempoAddress?: string | null;
  },
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'not_claimed' }> {
  const existing = await getWallet(address, chain);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (!existing.claimed) return { ok: false, reason: 'not_claimed' };

  const tempoFields =
    fields.tempoAddress !== undefined ? { tempo_address: fields.tempoAddress } : {};

  const { error } = await supabase
    .from('wallets')
    .update({
      display_name: fields.displayName,
      description: fields.description,
      website: fields.website,
      category: fields.category,
      image_url: fields.imageUrl,
      ...tempoFields,
      updated_at: new Date().toISOString(),
    })
    .eq('chain', chain)
    .eq('address', address);

  if (error) throw error;
  return { ok: true };
}

/**
 * Set or clear the declared Tempo (MPP) address on a wallet row. Used both by
 * the claim form and by the manifest resolver when an `agentkarma.json` declares
 * a tempoAddress. Tier 3 declared-only — never affects Karma.
 */
export async function setWalletTempoAddress(
  address: string,
  tempoAddress: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('wallets')
    .update({ tempo_address: tempoAddress, updated_at: new Date().toISOString() })
    .eq('address', address);
  if (error) throw error;
}

// --- Stellar ERC-8004 agentId (single definition; consumed by U3 publish/read
// and U4 claim) -----------------------------------------------------------------
//
// stellar_agent_id is the u32 agentId minted on Stellar's IdentityRegistry
// (trionlabs/stellar-8004). NULL until the agent claims/registers (U4). The
// publish path (U3) is identity-gated on this — no agentId, no on-chain feedback.

/**
 * Read the Stellar ERC-8004 agentId bound to a wallet. Returns null when the
 * wallet row is absent or the column is unset. Scoped to chain='stellar' since
 * the column only carries meaning on that chain.
 */
export async function getStellarAgentId(address: string): Promise<number | null> {
  const { data, error } = await supabase
    .from('wallets')
    .select('stellar_agent_id')
    .eq('chain', 'stellar')
    .eq('address', address)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') throw error;
  if (!data) return null;
  const id = (data as { stellar_agent_id: number | null }).stellar_agent_id;
  return id ?? null;
}

/**
 * Persist the Stellar ERC-8004 agentId on the wallet row after a successful
 * register_with_uri mint (U4). Chain-scoped to 'stellar' — never touches the
 * Solana/Celo rows that may share the address string.
 */
export async function setStellarAgentId(address: string, agentId: number): Promise<void> {
  const { error } = await supabase
    .from('wallets')
    .update({ stellar_agent_id: agentId, updated_at: new Date().toISOString() })
    .eq('chain', 'stellar')
    .eq('address', address);
  if (error) throw error;
}

// --- Transaction Queries -----------------------------------------------------

/**
 * Normalize a counterparty before persistence: empty strings and self-payments
 * (counterparty === the scored wallet) collapse to null, so they never create a
 * phantom counterparty bucket that inflates loyalty / diversity. Applied once at
 * the insert boundary, uniformly across ALL chains (Solana/Celo/Arc/Stellar).
 */
export function normalizeCounterparty(
  counterparty: string | null | undefined,
  walletAddress: string,
): string | null {
  if (!counterparty) return null;
  if (counterparty === walletAddress) return null;
  return counterparty;
}

export async function insertTransaction(
  tx: Omit<Transaction, 'id'>,
): Promise<void> {
  const { error } = await supabase
    .from('transactions')
    .upsert({
      chain: tx.chain,
      wallet_address: tx.wallet_address,
      facilitator: tx.facilitator,
      counterparty: normalizeCounterparty(tx.counterparty, tx.wallet_address),
      amount: tx.amount,
      timestamp: typeof tx.timestamp === 'string' ? tx.timestamp : new Date(tx.timestamp).toISOString(),
      success: tx.success,
      tx_signature: tx.tx_signature,
    }, { onConflict: 'tx_signature', ignoreDuplicates: true });

  if (error) throw error;
}

export async function insertTransactions(
  txs: Omit<Transaction, 'id'>[],
): Promise<number> {
  if (txs.length === 0) return 0;

  const rows = txs.map((tx) => ({
    chain: tx.chain,
    wallet_address: tx.wallet_address,
    facilitator: tx.facilitator,
    counterparty: normalizeCounterparty(tx.counterparty, tx.wallet_address),
    amount: tx.amount,
    timestamp: typeof tx.timestamp === 'string' ? tx.timestamp : new Date(tx.timestamp).toISOString(),
    success: tx.success,
    tx_signature: tx.tx_signature,
  }));

  const { data, error } = await supabase
    .from('transactions')
    .upsert(rows, { onConflict: 'tx_signature', ignoreDuplicates: true })
    .select('id');

  if (error) throw error;
  return data?.length ?? 0;
}

export async function getTransactions(
  walletAddress: string,
  limit = 50,
  offset = 0,
): Promise<Transaction[]> {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('wallet_address', walletAddress)
    .order('timestamp', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return (data ?? []) as Transaction[];
}

export async function getTransactionCount(walletAddress: string): Promise<number> {
  const { count, error } = await supabase
    .from('transactions')
    .select('*', { count: 'exact', head: true })
    .eq('wallet_address', walletAddress);

  if (error) throw error;
  return count ?? 0;
}

export async function getTransactionsForWallets(
  walletAddresses: string[],
): Promise<Transaction[]> {
  if (walletAddresses.length === 0) return [];

  const all: Transaction[] = [];
  // Supabase .in() encodes into the URL; chunk to stay under Kong's ~8KB URI cap.
  for (let i = 0; i < walletAddresses.length; i += ADDRESS_IN_CHUNK) {
    const chunk = walletAddresses.slice(i, i + ADDRESS_IN_CHUNK);
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .in('wallet_address', chunk)
      .order('timestamp', { ascending: false });

    if (error) throw error;
    if (data) all.push(...(data as Transaction[]));
  }

  return all;
}

export async function getAllTransactions(): Promise<Transaction[]> {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .order('timestamp', { ascending: false });

  if (error) throw error;
  return (data ?? []) as Transaction[];
}

// Bounded history fetch for a single wallet. Used by the rescore worker so
// cadence/autonomy/score compute stays O(limit) no matter how large the
// wallet's lifetime tx count is. Default 5000 ≫ MIN_TX_FOR_CADENCE (10) and
// is enough to reflect automation patterns for whale wallets.
export async function getRecentTransactionsForWallet(
  address: string,
  limit = 5000,
): Promise<Transaction[]> {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('wallet_address', address)
    .order('timestamp', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as Transaction[];
}

// --- Deferred Scoring Queue --------------------------------------------------
//
// The webhook hot path marks wallets dirty; a cron worker drains the queue.
// Keeps webhook response time bounded so Helius never auto-disables the
// webhook on 24h failure rate.

export async function markWalletsDirty(addresses: string[]): Promise<void> {
  if (addresses.length === 0) return;
  const now = new Date().toISOString();
  // Chunk to respect Kong's ~8KB URI cap on .in() filters (see ADDRESS_IN_CHUNK).
  for (let i = 0; i < addresses.length; i += ADDRESS_IN_CHUNK) {
    const chunk = addresses.slice(i, i + ADDRESS_IN_CHUNK);
    const { error } = await supabase
      .from('wallets')
      .update({ scoring_dirty_at: now })
      .in('address', chunk);
    if (error) throw error;
  }
}

/**
 * Pop up to `limit` oldest dirty wallet addresses and clear their dirty flag.
 * Not strictly atomic — two concurrent workers could claim the same wallet —
 * but scoring is idempotent (upsert + snapshot), so the cost of a collision
 * is a duplicate snapshot row, not corrupt state. `--skip-running` on the
 * Servel cron prevents overlap in practice.
 */
export async function claimDirtyWallets(limit = 100): Promise<string[]> {
  const { data, error } = await supabase
    .from('wallets')
    .select('address')
    .not('scoring_dirty_at', 'is', null)
    .order('scoring_dirty_at', { ascending: true })
    .limit(limit);

  if (error) throw error;
  const addresses = (data ?? []).map((row: { address: string }) => row.address);
  if (addresses.length === 0) return [];

  // Clear the dirty flag in URI-safe chunks. A single unchunked `.in()` over the
  // full claimed batch (up to 200) overflowed Kong's ~8KB URI cap → "URI too
  // long" → the whole drain threw before scoring anything, and since the rows
  // stayed dirty the next tick re-claimed them: a self-perpetuating stall.
  for (let i = 0; i < addresses.length; i += ADDRESS_IN_CHUNK) {
    const chunk = addresses.slice(i, i + ADDRESS_IN_CHUNK);
    const { error: clearError } = await supabase
      .from('wallets')
      .update({ scoring_dirty_at: null })
      .in('address', chunk);
    if (clearError) throw clearError;
  }

  return addresses;
}

export async function countDirtyWallets(): Promise<number> {
  const { count, error } = await supabase
    .from('wallets')
    .select('address', { count: 'exact', head: true })
    .not('scoring_dirty_at', 'is', null);
  if (error) throw error;
  return count ?? 0;
}

// --- Wallet-Scan Queue (Phase H+) -------------------------------------------
//
// Regressive history scans pull a wallet's full Helius signature stream so we
// can backfill x402 receipts the facilitator-side indexer never saw (e.g. when
// a brand-new agent is queried before our cursors have caught up to its
// genesis block). Decoupled from the dirty-queue: scans are heavier than
// rescoring, throttled per wallet, and tolerate stale workers via crash
// recovery. Idempotent throughout — `insertTransactions` and `signal_events`
// dedupe on natural unique keys.

export interface WalletScanInfo {
  state: WalletScanState | null;
  requestedAt: string | null;
  completedAt: string | null;
  attempts: number;
  hitCount: number;
  partial: boolean;
  lastError: string | null;
}

export interface EnqueueWalletScanResult {
  enqueued: boolean;
  reason?: 'invalid' | 'in_progress' | 'cooldown' | 'already_indexed';
}

const SCAN_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Enqueue a wallet for regressive history scan. Idempotent. Cooldown rules:
 * - already pending/scanning → no-op (reason: 'in_progress')
 * - completed within last 24h → no-op (reason: 'cooldown')
 * - wallet has tx_count > 0 (already indexed via facilitator-side scan) → no-op (reason: 'already_indexed')
 * Otherwise upsert wallet stub with scan_state='pending', scan_requested_at=now().
 */
export async function enqueueWalletScan(
  address: string,
  chain: Chain = DEFAULT_CHAIN,
): Promise<EnqueueWalletScanResult> {
  if (!address || typeof address !== 'string') {
    return { enqueued: false, reason: 'invalid' };
  }

  const { data, error } = await supabase
    .from('wallets')
    .select('tx_count, scan_state, scan_completed_at')
    .eq('chain', chain)
    .eq('address', address)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') throw error;

  if (data) {
    const row = data as { tx_count: number | null; scan_state: WalletScanState | null; scan_completed_at: string | null };
    if (row.scan_state === 'pending' || row.scan_state === 'scanning') {
      return { enqueued: false, reason: 'in_progress' };
    }
    if ((row.tx_count ?? 0) > 0) {
      return { enqueued: false, reason: 'already_indexed' };
    }
    // Cooldown applies only to successful scans. Failed scans are eligible
    // for immediate retry — the worker's per-tick recoverStuckScans handles
    // genuinely-stuck rows; here we let the operator/UI re-enqueue freely.
    if (row.scan_state === 'done' && row.scan_completed_at) {
      const completedMs = new Date(row.scan_completed_at).getTime();
      if (Date.now() - completedMs < SCAN_COOLDOWN_MS) {
        return { enqueued: false, reason: 'cooldown' };
      }
    }
  }

  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    chain,
    address,
    scan_state: 'pending',
    scan_requested_at: now,
    updated_at: now,
  };
  // Insert-only defaults for first-time stubs; existing rows preserve these.
  if (!data) {
    row.score = 0;
    row.trust_tier = 'Unrated';
    row.tx_count = 0;
  }

  const { error: upsertError } = await supabase
    .from('wallets')
    .upsert(row, { onConflict: 'chain,address' });
  if (upsertError) throw upsertError;

  return { enqueued: true };
}

/**
 * Atomically claim up to `limit` pending scans, flipping their state to 'scanning'
 * and incrementing scan_attempts. Mirrors claimDirtyWallets — non-atomic across
 * concurrent workers but scan body is idempotent (insertTransactions / signal_events
 * have unique constraints), so collisions are tolerable. Order by scan_requested_at ASC.
 */
export async function claimWalletScans(limit = 5): Promise<string[]> {
  const { data, error } = await supabase
    .from('wallets')
    .select('address, scan_attempts, scan_requested_at')
    .eq('scan_state', 'pending')
    .order('scan_requested_at', { ascending: true, nullsFirst: true })
    .limit(limit);

  if (error) throw error;
  const rows = (data ?? []) as { address: string; scan_attempts: number | null; scan_requested_at: string | null }[];
  if (rows.length === 0) return [];

  const now = new Date().toISOString();
  const claimed: string[] = [];
  // Per-row update so we can preserve existing scan_requested_at and bump
  // attempts atomically against the pre-read value.
  for (const row of rows) {
    const update: Record<string, unknown> = {
      scan_state: 'scanning',
      scan_attempts: (row.scan_attempts ?? 0) + 1,
      updated_at: now,
    };
    if (!row.scan_requested_at) update.scan_requested_at = now;

    const { error: updateError } = await supabase
      .from('wallets')
      .update(update)
      .eq('address', row.address);
    if (updateError) throw updateError;
    claimed.push(row.address);
  }

  return claimed;
}

/**
 * Mark scan complete. Sets scan_state='done', scan_completed_at=now(),
 * scan_hit_count=hits, scan_partial=partial, scan_last_error=null.
 */
export async function markWalletScanComplete(
  address: string,
  hits: number,
  partial: boolean,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('wallets')
    .update({
      scan_state: 'done',
      scan_completed_at: now,
      scan_hit_count: hits,
      scan_partial: partial,
      scan_last_error: null,
      updated_at: now,
    })
    .eq('address', address);
  if (error) throw error;
}

/**
 * Mark scan failed. Sets scan_state='failed', scan_completed_at=now(),
 * scan_last_error=err. Preserves scan_attempts for retry visibility.
 */
export async function markWalletScanFailed(address: string, err: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('wallets')
    .update({
      scan_state: 'failed',
      scan_completed_at: now,
      scan_last_error: err,
      updated_at: now,
    })
    .eq('address', address);
  if (error) throw error;
}

/**
 * Read current scan state for a single wallet. Returns null if wallet row absent.
 */
export async function getWalletScanState(address: string): Promise<WalletScanInfo | null> {
  const { data, error } = await supabase
    .from('wallets')
    .select('scan_state, scan_requested_at, scan_completed_at, scan_attempts, scan_hit_count, scan_partial, scan_last_error')
    .eq('address', address)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') throw error;
  if (!data) return null;

  const row = data as {
    scan_state: WalletScanState | null;
    scan_requested_at: string | null;
    scan_completed_at: string | null;
    scan_attempts: number | null;
    scan_hit_count: number | null;
    scan_partial: boolean | null;
    scan_last_error: string | null;
  };

  return {
    state:       row.scan_state,
    requestedAt: row.scan_requested_at,
    completedAt: row.scan_completed_at,
    attempts:    row.scan_attempts ?? 0,
    hitCount:    row.scan_hit_count ?? 0,
    partial:     row.scan_partial ?? false,
    lastError:   row.scan_last_error,
  };
}

/**
 * Sweep orphaned 'scanning' rows older than `staleMs` ms back to 'pending'.
 * Recovers from worker crashes mid-scan. Call at top of every worker tick.
 * Returns count of rows recovered.
 */
export async function recoverStuckScans(staleMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('wallets')
    .update({ scan_state: 'pending', updated_at: now })
    .eq('scan_state', 'scanning')
    .lt('scan_requested_at', cutoff)
    .select('address');
  if (error) throw error;
  return data?.length ?? 0;
}

// --- Score Snapshots ---------------------------------------------------------

export async function insertScoreSnapshot(
  walletAddress: string,
  score: number,
  successRate: number,
  diversity: number,
  volume: number,
  age: number,
): Promise<void> {
  const { error } = await supabase
    .from('scores')
    .insert({
      wallet_address: walletAddress,
      score,
      success_rate: successRate,
      diversity,
      volume,
      age: Math.round(age * 180), // denormalize 0-1 back to days (cap 180)
    });

  if (error) throw error;
}

export async function getScoreHistory(
  walletAddress: string,
  limit = 30,
): Promise<{ score: number; calculated_at: string }[]> {
  const { data, error } = await supabase
    .from('scores')
    .select('score, calculated_at')
    .eq('wallet_address', walletAddress)
    .order('calculated_at', { ascending: true })
    .limit(limit);

  if (error) throw error;
  return (data ?? []).map((r: { score: number; calculated_at: string }) => ({
    score: Number(r.score),
    calculated_at: r.calculated_at,
  }));
}

export async function cleanupOldScoreSnapshots(days = 90): Promise<number> {
  const { data, error } = await supabase.rpc('cleanup_score_snapshots', { retention_days: days });
  if (error) {
    // SQL function not deployed yet — skip silently
    console.warn('[db] cleanup_score_snapshots function not available, skipping');
    return 0;
  }
  return Number(data ?? 0);
}

// --- Stats Queries -----------------------------------------------------------

export async function getStats() {
  // Every figure comes from a SQL aggregate RPC — NEVER from streaming the full
  // transactions (~502k) or agent (~103k) tables. The old row-streaming
  // fallbacks (`select amount` / `select trust_tier`) blew the 8s statement
  // timeout as the tables grew and 500'd /api/stats (the public homepage
  // counter). Each block degrades independently so one slow query can't take the
  // whole endpoint down — getStats returns best-effort, never throws.
  let totalTransactions = 0;
  let totalVolumeUsdc = 0;
  const txStatsRes = await supabase.rpc('get_transaction_stats').single();
  if (!txStatsRes.error && txStatsRes.data) {
    const stats = txStatsRes.data as Record<string, unknown>;
    totalTransactions = Number(stats.total_count ?? 0);
    totalVolumeUsdc = Number(stats.total_volume ?? 0);
  } else if (txStatsRes.error) {
    console.warn('[db] get_transaction_stats unavailable:', txStatsRes.error.message);
  }

  // totalAgents + tierDistribution count the canonical agent population — the
  // `explore_agents` view (score-gated Solana/Stellar wallets UNIONed with the
  // per-agent Celo/Arc registry mirror). This is the SAME set the Explore "All"
  // count reads, so the homepage counter and Explore never disagree. Counting
  // raw `wallets` instead double-faults: it keeps score=0 noise and represents
  // Celo/Arc as a handful of owner rows rather than their per-agent population.
  let totalAgents = 0;
  const tierDistribution: Record<string, number> = {};
  const tierRes = await supabase.rpc('get_tier_distribution');
  if (!tierRes.error && Array.isArray(tierRes.data)) {
    for (const row of tierRes.data as { trust_tier: string; count: number }[]) {
      const n = Number(row.count);
      tierDistribution[row.trust_tier] = n;
      totalAgents += n;
    }
  } else {
    if (tierRes.error) console.warn('[db] get_tier_distribution unavailable:', tierRes.error.message);
    // Cheap degradation: a HEAD count (no row scan) so totalAgents survives —
    // over the same view, so the degraded number stays consistent with Explore.
    const headRes = await supabase.from('explore_agents').select('*', { count: 'exact', head: true });
    totalAgents = headRes.count ?? 0;
  }

  // Per-chain ERC-8004 registry mirror totals (agents + feedback records) so
  // the public stats match 8004scan's per-network cards. Best-effort + additive
  // — a failure here never takes down the existing figures above.
  let registries: { chain: string; agents: number; feedbacks: number }[] = [];
  try {
    registries = await getRegistryStats();
  } catch (err) {
    console.warn('[db] getRegistryStats unavailable:', err instanceof Error ? err.message : err);
  }

  return { totalAgents, totalTransactions, totalVolumeUsdc, tierDistribution, registries };
}

// --- Explore Queries ---------------------------------------------------------

export async function getFacilitatorStats(): Promise<{
  facilitator: string;
  txCount: number;
  uniqueAgents: number;
  totalVolume: number;
  lastActive: string | null;
}[]> {
  // Try SQL function first, fall back to JS aggregation if not deployed
  const rpcRes = await supabase.rpc('get_facilitator_stats');

  if (!rpcRes.error && rpcRes.data) {
    return (rpcRes.data as { facilitator: string; tx_count: number; unique_agents: number; total_volume: number; last_active: string | null }[]).map((row) => ({
      facilitator: row.facilitator,
      txCount: Number(row.tx_count),
      uniqueAgents: Number(row.unique_agents),
      totalVolume: Number(row.total_volume),
      lastActive: row.last_active,
    }));
  }

  // Fallback: JS aggregation (bounded to recent activity to avoid full-table scans)
  const { data, error } = await supabase
    .from('transactions')
    .select('facilitator, wallet_address, amount, timestamp')
    .order('timestamp', { ascending: false })
    .limit(5000);

  if (error) throw error;

  const map = new Map<string, {
    txCount: number;
    agents: Set<string>;
    volume: number;
    lastTs: string;
  }>();

  for (const tx of (data ?? []) as { facilitator: string; wallet_address: string; amount: number; timestamp: string }[]) {
    const entry = map.get(tx.facilitator) ?? {
      txCount: 0,
      agents: new Set<string>(),
      volume: 0,
      lastTs: tx.timestamp,
    };
    entry.txCount++;
    entry.agents.add(tx.wallet_address);
    entry.volume += Number(tx.amount);
    if (tx.timestamp > entry.lastTs) entry.lastTs = tx.timestamp;
    map.set(tx.facilitator, entry);
  }

  return Array.from(map.entries())
    .map(([facilitator, s]) => ({
      facilitator,
      txCount: s.txCount,
      uniqueAgents: s.agents.size,
      totalVolume: s.volume,
      lastActive: s.lastTs,
    }))
    .sort((a, b) => b.txCount - a.txCount);
}

export async function getRecentTransactions(
  facilitator?: string,
  limit = 30,
  since?: Date,
): Promise<Transaction[]> {
  let query = supabase
    .from('transactions')
    .select('*')
    .order('timestamp', { ascending: false })
    .limit(limit);

  if (facilitator) {
    query = query.eq('facilitator', facilitator);
  }
  if (since) {
    query = query.gte('timestamp', since.toISOString());
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Transaction[];
}

export async function getWalletTiers(
  addresses: string[],
): Promise<Map<string, TrustTier>> {
  const out = new Map<string, TrustTier>();
  if (addresses.length === 0) return out;

  for (let i = 0; i < addresses.length; i += ADDRESS_IN_CHUNK) {
    const chunk = addresses.slice(i, i + ADDRESS_IN_CHUNK);
    const { data, error } = await supabase
      .from('wallets')
      .select('address, trust_tier')
      .in('address', chunk);

    if (error) throw error;
    for (const row of (data ?? []) as { address: string; trust_tier: TrustTier }[]) {
      out.set(row.address, row.trust_tier);
    }
  }
  return out;
}

// --- Deck Views --------------------------------------------------------------

export interface InsertDeckViewInput {
  email: string;
  isReturning?: boolean;
  ip?: string | null;
  userAgent?: string | null;
  referrer?: string | null;
}

export async function insertDeckView(input: InsertDeckViewInput): Promise<void> {
  const { error } = await supabase
    .from('deck_views')
    .insert({
      email:        input.email,
      is_returning: input.isReturning ?? false,
      ip:           input.ip ?? null,
      user_agent:   input.userAgent ?? null,
      referrer:     input.referrer ?? null,
    });
  if (error) throw error;
}

/**
 * Total deck-view count — every visit counts (HEAD-only count query, cheap).
 */
export async function getDeckViewCount(): Promise<number> {
  const { count, error } = await supabase
    .from('deck_views')
    .select('*', { count: 'exact', head: true });
  if (error) throw error;
  return count ?? 0;
}

// --- Indexer Cursors ----------------------------------------------------------

export async function getCursor(
  facilitator: string,
  chain: Chain = DEFAULT_CHAIN,
): Promise<IndexerCursor | null> {
  const { data, error } = await supabase
    .from('indexer_cursors')
    .select('*')
    .eq('chain', chain)
    .eq('facilitator', facilitator)
    .single();

  if (error && error.code === 'PGRST116') return null;
  if (error) throw error;
  return data as IndexerCursor;
}

export async function upsertCursor(
  facilitator: string,
  lastSignature: string,
  lastSlot?: number,
  chain: Chain = DEFAULT_CHAIN,
): Promise<void> {
  const { error } = await supabase
    .from('indexer_cursors')
    .upsert({
      chain,
      facilitator,
      last_signature: lastSignature,
      last_slot: lastSlot ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'chain,facilitator' });

  if (error) throw error;
}

// --- ERC-8004 feedback comments ----------------------------------------------
// The feedback-URI scanner (src/indexer/erc8004-feedback-uri.ts) backfills the
// inline review carried in a NewFeedback event's feedbackURI. These columns are
// additive on erc8004_feedback (migration 0014); the row itself is created by
// the registry scanner, so this is UPDATE-only and never clobbers value/revoked.

/** Structural shape of a decoded comment record (matches indexer ScannedComment). */
export interface FeedbackCommentUpdate {
  agentId: number;
  client: string;
  feedbackIndex: number;
  feedbackUri: string;
  feedbackHash: string;
  comment: string | null;
  commentVerified: boolean;
}

/**
 * UPDATE comment columns on existing erc8004_feedback rows, keyed by the full
 * (chain, agent_id, client, feedback_index) PK. Returns the number of rows
 * actually touched — a record whose registry row hasn't been inserted yet
 * updates nothing (it lands on the next pass, by design). Per-row because
 * comment-bearing feedback is sparse.
 */
export async function updateFeedbackComments<T extends FeedbackCommentUpdate>(
  chain: Chain,
  rows: T[],
): Promise<{ updated: number; unmatched: T[] }> {
  let updated = 0;
  const unmatched: T[] = [];
  for (const r of rows) {
    const { error, count } = await supabase
      .from('erc8004_feedback')
      .update(
        {
          feedback_uri: r.feedbackUri,
          feedback_hash: r.feedbackHash,
          comment: r.comment,
          comment_verified: r.commentVerified,
        },
        { count: 'exact' },
      )
      .eq('chain', chain)
      .eq('agent_id', r.agentId)
      .eq('client', r.client)
      .eq('feedback_index', r.feedbackIndex);
    if (error) throw error;
    // 0 rows matched → the registry scanner hasn't inserted this feedback row
    // yet. Report it so the scanner can rewind its cursor and retry next run,
    // instead of advancing past it and losing the comment.
    if ((count ?? 0) === 0) unmatched.push(r);
    else updated += count ?? 0;
  }
  return { updated, unmatched };
}

/**
 * Comments for an agent's feedback, keyed by `${lowercasedClient}-${index}` so
 * the profile can merge them onto the live readAllFeedback records (whose client
 * is a checksum address — look up with `.toLowerCase()`). Only rows with a
 * decoded comment are returned.
 */
export async function getFeedbackComments(
  chain: Chain,
  agentId: number,
): Promise<Map<string, { comment: string; verified: boolean }>> {
  const { data, error } = await supabase
    .from('erc8004_feedback')
    .select('client, feedback_index, comment, comment_verified')
    .eq('chain', chain)
    .eq('agent_id', agentId)
    .not('comment', 'is', null);

  if (error) throw error;
  const out = new Map<string, { comment: string; verified: boolean }>();
  for (const r of (data ?? []) as Array<{ client: string; feedback_index: number; comment: string; comment_verified: boolean }>) {
    out.set(`${r.client.toLowerCase()}-${r.feedback_index}`, { comment: r.comment, verified: r.comment_verified });
  }
  return out;
}

// --- Signal Events (Phase F) -------------------------------------------------

export interface InsertSignalEventInput {
  agentWallet: string;
  /**
   * Owning chain for the (chain, agent_wallet) FK + dedup index. Optional for
   * back-compat: omitted = DB default 'solana' (every pre-existing caller). NEW
   * multi-chain callers (heartbeat worker, future chain indexers) MUST set it so
   * the signal row keys to the right wallet — never auto-detect from address.
   */
  chain?: Chain;
  tier: SignalTier;
  kind: string;
  face?: KarmaFace;
  weight?: number;
  value?: number | null;
  payload?: Record<string, unknown> | null;
  signedBy?: string | null;
  txRef?: string | null;
  observedAt?: string | Date;
}

function toSignalRow(input: InsertSignalEventInput): Record<string, unknown> {
  const row: Record<string, unknown> = {
    agent_wallet: input.agentWallet,
    tier: input.tier,
    kind: input.kind,
    face: input.face ?? 'provider',
    weight: input.weight ?? 1.0,
  };
  if (input.chain !== undefined) row.chain = input.chain;
  if (input.value !== undefined) row.value = input.value;
  if (input.payload !== undefined) row.payload = input.payload;
  if (input.signedBy !== undefined) row.signed_by = input.signedBy;
  if (input.txRef !== undefined) row.tx_ref = input.txRef;
  if (input.observedAt !== undefined) {
    row.observed_at = typeof input.observedAt === 'string'
      ? input.observedAt
      : input.observedAt.toISOString();
  }
  return row;
}

export interface InsertSignalEventOpts {
  /**
   * When true, overwrite the existing row on conflict (use for aggregate
   * signals like cadence that summarize current state). When false (default),
   * skip duplicates (use for per-event signals keyed by tx_signature).
   */
  overwrite?: boolean;
}

export async function insertSignalEvent(
  input: InsertSignalEventInput,
  opts: InsertSignalEventOpts = {},
): Promise<void> {
  const { error } = await supabase
    .from('signal_events')
    .upsert(toSignalRow(input), {
      onConflict: 'chain,agent_wallet,kind,tx_ref',
      ignoreDuplicates: !opts.overwrite,
    });

  if (error) throw error;
}

export async function insertSignalEvents(
  inputs: InsertSignalEventInput[],
  opts: InsertSignalEventOpts = {},
): Promise<number> {
  if (inputs.length === 0) return 0;

  let total = 0;
  for (let i = 0; i < inputs.length; i += 500) {
    const rows = inputs.slice(i, i + 500).map(toSignalRow);
    const { data, error } = await supabase
      .from('signal_events')
      .upsert(rows, {
        onConflict: 'chain,agent_wallet,kind,tx_ref',
        ignoreDuplicates: !opts.overwrite,
      })
      .select('id');
    if (error) throw error;
    total += data?.length ?? 0;
  }
  return total;
}

export async function getSignalEventsForWallet(
  agentWallet: string,
  limit = 200,
): Promise<SignalEvent[]> {
  const { data, error } = await supabase
    .from('signal_events')
    .select('*')
    .eq('agent_wallet', agentWallet)
    .order('observed_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as SignalEvent[];
}

/**
 * Fetch the most-recent signal `value` per wallet for a given kind.
 * Used by scoring to read aggregate signals (cadence, breadth) when present.
 * Returns a plain map wallet → numeric value.
 */
export async function getLatestSignalValues(
  agentWallets: string[],
  kind: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (agentWallets.length === 0) return out;

  // Chunk size kept low because PostgREST encodes the filter list in the URL
  // as ?agent_wallet=in.(a,b,c,…) and base58 wallet addresses are ~44 chars
  // each — 500 would exceed Supabase's 8KB URI limit on fleet-wide backfills.
  for (let i = 0; i < agentWallets.length; i += 100) {
    const chunk = agentWallets.slice(i, i + 100);
    const { data, error } = await supabase
      .from('signal_events')
      .select('agent_wallet, value, observed_at')
      .eq('kind', kind)
      .in('agent_wallet', chunk)
      .order('observed_at', { ascending: false });

    if (error) throw error;

    for (const row of (data ?? []) as { agent_wallet: string; value: number | null; observed_at: string }[]) {
      if (out.has(row.agent_wallet)) continue; // keep only the most recent per wallet
      if (row.value != null) out.set(row.agent_wallet, Number(row.value));
    }
  }
  return out;
}

/**
 * Count signal_events of a given kind, grouped by wallet. Used by scoring
 * to know how many pay.sh-routed receipts a wallet has accumulated.
 */
export async function countSignalEventsByKind(
  agentWallets: string[],
  kind: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (agentWallets.length === 0) return out;

  for (let i = 0; i < agentWallets.length; i += 100) {
    const chunk = agentWallets.slice(i, i + 100);
    const { data, error } = await supabase
      .from('signal_events')
      .select('agent_wallet')
      .eq('kind', kind)
      .in('agent_wallet', chunk);

    if (error) throw error;
    for (const row of (data ?? []) as { agent_wallet: string }[]) {
      out.set(row.agent_wallet, (out.get(row.agent_wallet) ?? 0) + 1);
    }
  }
  return out;
}

/**
 * Aggregate pay.sh `paysh_routed` provider-face signal_events for a set of
 * operator addresses. Used by the indexer's operator-scoring pass to derive
 * Provider Karma for gateway operators (who have no `transactions` rows and
 * cannot be scored by the main scoring engine).
 *
 * Returns per operator: receipt count, unique-payer count (extracted from
 * `payload.payer`), and most-recent `observed_at`. Operators absent from the
 * input list never appear in the result; operators with zero matching
 * signals also do not appear.
 */
export async function getPayshOperatorReceiptStats(
  operatorAddresses: string[],
): Promise<Map<string, { receiptCount: number; uniquePayerCount: number; lastSeen: string | null }>> {
  const out = new Map<string, { receiptCount: number; uniquePayerCount: number; lastSeen: string | null }>();
  if (operatorAddresses.length === 0) return out;

  const payersByOperator = new Map<string, Set<string>>();

  for (let i = 0; i < operatorAddresses.length; i += 100) {
    const chunk = operatorAddresses.slice(i, i + 100);
    const { data, error } = await supabase
      .from('signal_events')
      .select('agent_wallet, payload, observed_at')
      .eq('kind', 'paysh_routed')
      .eq('face', 'provider')
      .in('agent_wallet', chunk);

    if (error) throw error;

    for (const row of (data ?? []) as Array<{
      agent_wallet: string;
      payload: Record<string, unknown> | null;
      observed_at: string;
    }>) {
      const existing = out.get(row.agent_wallet);
      const lastSeen = existing?.lastSeen && existing.lastSeen >= row.observed_at
        ? existing.lastSeen
        : row.observed_at;
      const next = {
        receiptCount: (existing?.receiptCount ?? 0) + 1,
        uniquePayerCount: 0,
        lastSeen,
      };
      out.set(row.agent_wallet, next);

      const payer = row.payload && typeof row.payload === 'object'
        ? (row.payload as { payer?: unknown }).payer
        : null;
      if (typeof payer === 'string' && payer.length > 0) {
        const set = payersByOperator.get(row.agent_wallet) ?? new Set<string>();
        set.add(payer);
        payersByOperator.set(row.agent_wallet, set);
      }
    }
  }

  for (const [operator, stats] of out) {
    stats.uniquePayerCount = payersByOperator.get(operator)?.size ?? 0;
  }

  return out;
}

export async function getSignalEventsForWallets(
  agentWallets: string[],
): Promise<Map<string, SignalEvent[]>> {
  const out = new Map<string, SignalEvent[]>();
  if (agentWallets.length === 0) return out;

  for (let i = 0; i < agentWallets.length; i += 100) {
    const chunk = agentWallets.slice(i, i + 100);
    const { data, error } = await supabase
      .from('signal_events')
      .select('*')
      .in('agent_wallet', chunk)
      .order('observed_at', { ascending: false });

    if (error) throw error;
    for (const row of (data ?? []) as SignalEvent[]) {
      const list = out.get(row.agent_wallet) ?? [];
      list.push(row);
      out.set(row.agent_wallet, list);
    }
  }
  return out;
}

// --- Organizations (Enterprise fleet view) ----------------------------------

export interface UpsertOrganizationInput {
  slug: string;
  name: string;
  description?: string | null;
  website?: string | null;
  logoUrl?: string | null;
  verified?: boolean;
}

export async function upsertOrganization(input: UpsertOrganizationInput): Promise<void> {
  const { error } = await supabase
    .from('organizations')
    .upsert({
      slug:        input.slug,
      name:        input.name,
      description: input.description ?? null,
      website:     input.website ?? null,
      logo_url:    input.logoUrl ?? null,
      verified:    input.verified ?? false,
    }, { onConflict: 'slug' });

  if (error) throw error;
}

export async function getOrganization(slug: string): Promise<Organization | null> {
  const { data, error } = await supabase
    .from('organizations')
    .select('*')
    .eq('slug', slug)
    .single();
  if (error && error.code === 'PGRST116') return null;
  if (error) throw error;
  return data as Organization;
}

export async function listOrganizations(): Promise<Array<Organization & { memberCount: number }>> {
  const { data, error } = await supabase
    .from('organizations')
    .select('*, organization_members(count)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as (Organization & { organization_members?: { count: number }[] })[]).map((o) => ({
    ...o,
    memberCount: o.organization_members?.[0]?.count ?? 0,
  }));
}

export async function addOrganizationMember(
  slug: string, agentWallet: string, role: string | null = null,
): Promise<void> {
  const { error } = await supabase
    .from('organization_members')
    .upsert({
      organization_slug: slug,
      agent_wallet:      agentWallet,
      role,
    }, { onConflict: 'organization_slug,agent_wallet' });
  if (error) throw error;
}

export async function getOrganizationMembers(slug: string): Promise<OrganizationMember[]> {
  const { data, error } = await supabase
    .from('organization_members')
    .select('*')
    .eq('organization_slug', slug)
    .order('added_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as OrganizationMember[];
}

export async function getOrganizationForWallet(agentWallet: string): Promise<Organization | null> {
  const { data, error } = await supabase
    .from('organization_members')
    .select('organization_slug, organizations(*)')
    .eq('agent_wallet', agentWallet)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const orgs = (data as unknown as { organizations: Organization | null }).organizations;
  return orgs ?? null;
}

// --- Agent Manifests (Phase H1) ---------------------------------------------

export interface UpsertAgentManifestInput {
  agentWallet: string;
  sourceType: ManifestSourceType;
  url: string | null;
  raw: Record<string, unknown> | null;
  parsed: ParsedManifest | null;
  verified: boolean;
}

export async function upsertAgentManifest(input: UpsertAgentManifestInput): Promise<void> {
  const { error } = await supabase
    .from('agent_manifests')
    .upsert({
      agent_wallet: input.agentWallet,
      source_type:  input.sourceType,
      url:          input.url,
      raw:          input.raw,
      parsed:       input.parsed,
      verified:     input.verified,
      fetched_at:   new Date().toISOString(),
    }, { onConflict: 'agent_wallet,source_type' });

  if (error) throw error;
}

export async function getAgentManifestsForWallet(
  agentWallet: string,
): Promise<AgentManifest[]> {
  const { data, error } = await supabase
    .from('agent_manifests')
    .select('*')
    .eq('agent_wallet', agentWallet)
    .order('fetched_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as AgentManifest[];
}

export async function getAgentManifestsForWallets(
  agentWallets: string[],
): Promise<Map<string, AgentManifest[]>> {
  const out = new Map<string, AgentManifest[]>();
  if (agentWallets.length === 0) return out;

  for (let i = 0; i < agentWallets.length; i += ADDRESS_IN_CHUNK) {
    const chunk = agentWallets.slice(i, i + ADDRESS_IN_CHUNK);
    const { data, error } = await supabase
      .from('agent_manifests')
      .select('*')
      .in('agent_wallet', chunk);

    if (error) throw error;
    for (const row of (data ?? []) as AgentManifest[]) {
      const list = out.get(row.agent_wallet) ?? [];
      list.push(row);
      out.set(row.agent_wallet, list);
    }
  }
  return out;
}

// --- Consumer Feedback -------------------------------------------------------

export async function insertFeedback(
  agentWallet: string,
  consumerWallet: string,
  rating: FeedbackRating,
  txSignature: string,
): Promise<void> {
  const { error } = await supabase
    .from('feedback')
    .insert({
      agent_wallet: agentWallet,
      consumer_wallet: consumerWallet,
      rating,
      tx_signature: txSignature,
    });

  if (error) throw error;
}

export async function getFeedbackForAgent(
  agentWallet: string,
  limit = 50,
): Promise<Feedback[]> {
  const { data, error } = await supabase
    .from('feedback')
    .select('*')
    .eq('agent_wallet', agentWallet)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as Feedback[];
}

export async function getFeedbackSummary(
  agentWallet: string,
): Promise<{ total: number; delivered: number; failed: number; deliveryRate: number }> {
  const { data, error } = await supabase
    .from('feedback')
    .select('rating')
    .eq('agent_wallet', agentWallet);

  if (error) throw error;

  const rows = (data ?? []) as { rating: string }[];
  const total = rows.length;
  const delivered = rows.filter((r) => r.rating === 'delivered').length;
  const failed = total - delivered;
  const deliveryRate = total > 0 ? delivered / total : 0;

  return { total, delivered, failed, deliveryRate };
}

export async function getFeedbackRatingsForSignatures(
  txSignatures: string[],
): Promise<Map<string, 'delivered' | 'failed'>> {
  const out = new Map<string, 'delivered' | 'failed'>();
  if (txSignatures.length === 0) return out;

  for (let i = 0; i < txSignatures.length; i += SIGNATURE_IN_CHUNK) {
    const chunk = txSignatures.slice(i, i + SIGNATURE_IN_CHUNK);
    const { data, error } = await supabase
      .from('feedback')
      .select('tx_signature, rating')
      .in('tx_signature', chunk);

    if (error) throw error;
    for (const row of (data ?? []) as { tx_signature: string; rating: string }[]) {
      if (row.rating === 'delivered' || row.rating === 'failed') {
        out.set(row.tx_signature, row.rating);
      }
    }
  }
  return out;
}

export async function getFeedbackSummariesForWallets(
  agentWallets: string[],
): Promise<Map<string, { total: number; delivered: number; failed: number; deliveryRate: number }>> {
  const out = new Map<string, { total: number; delivered: number; failed: number; deliveryRate: number }>();
  if (agentWallets.length === 0) return out;

  for (let i = 0; i < agentWallets.length; i += ADDRESS_IN_CHUNK) {
    const chunk = agentWallets.slice(i, i + ADDRESS_IN_CHUNK);
    const { data, error } = await supabase
      .from('feedback')
      .select('agent_wallet, rating')
      .in('agent_wallet', chunk);

    if (error) throw error;
    for (const row of (data ?? []) as { agent_wallet: string; rating: string }[]) {
      const current = out.get(row.agent_wallet) ?? { total: 0, delivered: 0, failed: 0, deliveryRate: 0 };
      current.total++;
      if (row.rating === 'delivered') current.delivered++;
      else current.failed++;
      current.deliveryRate = current.delivered / current.total;
      out.set(row.agent_wallet, current);
    }
  }
  return out;
}

export async function getScoreHistoriesForWallets(
  walletAddresses: string[],
  sincesDaysAgo = 30,
  maxPerWallet = 30,
): Promise<Map<string, { score: number; calculated_at: string }[]>> {
  const out = new Map<string, { score: number; calculated_at: string }[]>();
  if (walletAddresses.length === 0) return out;

  const since = new Date(Date.now() - sincesDaysAgo * 24 * 60 * 60 * 1000).toISOString();

  for (let i = 0; i < walletAddresses.length; i += ADDRESS_IN_CHUNK) {
    const chunk = walletAddresses.slice(i, i + ADDRESS_IN_CHUNK);
    const { data, error } = await supabase
      .from('scores')
      .select('wallet_address, score, calculated_at')
      .in('wallet_address', chunk)
      .gte('calculated_at', since)
      .order('calculated_at', { ascending: true });

    if (error) throw error;

    for (const row of (data ?? []) as { wallet_address: string; score: number; calculated_at: string }[]) {
      const list = out.get(row.wallet_address) ?? [];
      list.push({ score: Number(row.score), calculated_at: row.calculated_at });
      out.set(row.wallet_address, list);
    }
  }

  // Trim each list to maxPerWallet (keep last N)
  for (const [addr, list] of out) {
    if (list.length > maxPerWallet) {
      out.set(addr, list.slice(-maxPerWallet));
    }
  }
  return out;
}

export async function hasFeedbackForTx(txSignature: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('feedback')
    .select('id')
    .eq('tx_signature', txSignature)
    .limit(1);

  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function getTransactionBySig(txSignature: string): Promise<Transaction | null> {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('tx_signature', txSignature)
    .single();

  if (error && error.code === 'PGRST116') return null;
  if (error) throw error;
  return data as Transaction;
}

// --- Successions / Dead Man's Switch (Agent Wills) ---------------------------
//
// AK is read-only over the succession lifecycle (RFC §12 Non-Custody). These
// helpers project the `successions` table for the public Agent Estates feed and
// the per-agent succession endpoint. NEVER write/execute a will here.

/**
 * Read the declared succession plan for one agent. Chain-scoped — (chain,
 * agent_wallet) is the composite PK. Returns null when no will is declared.
 */
export async function getSuccession(
  agentWallet: string,
  chain: Chain = DEFAULT_CHAIN,
): Promise<Succession | null> {
  const { data, error } = await supabase
    .from('successions')
    .select('*')
    .eq('chain', chain)
    .eq('agent_wallet', agentWallet)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') throw error;
  if (!data) return null;
  return data as Succession;
}

export interface ReapableFilters {
  chain?: Chain;
  /** Statuses to include; defaults to the "reapable" set below. */
  statuses?: SuccessionStatus[];
}

export interface ReapablePage {
  successions: Succession[];
  total: number;
}

/** Statuses surfaced in the public Agent Estates feed (estate is claimable). */
export const REAPABLE_STATUSES: SuccessionStatus[] = ['lapsing', 'lapsed', 'executed'];

/**
 * Page the public Agent Estates feed: declared wills whose status is in the
 * reapable set (lapsing/lapsed/executed by default). Ordered by last_heartbeat
 * ascending (most-stale first) so the freshest reapable estates surface up top.
 * Optionally chain-filtered.
 */
export async function getReapableSuccessions(
  limit = 25,
  offset = 0,
  filters: ReapableFilters = {},
): Promise<ReapablePage> {
  const statuses = filters.statuses?.length ? filters.statuses : REAPABLE_STATUSES;

  let q = supabase
    .from('successions')
    .select('*', { count: 'exact' })
    .in('status', statuses);

  if (filters.chain) q = q.eq('chain', filters.chain);

  const { data, error, count } = await q
    // NULLs (never any heartbeat) first — those are the stalest of all.
    .order('last_heartbeat_at', { ascending: true, nullsFirst: true })
    .order('agent_wallet', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return { successions: (data ?? []) as Succession[], total: count ?? 0 };
}

/**
 * Upsert a declared succession plan. (chain, agent_wallet) is the composite PK,
 * so re-declaring OVERWRITES the prior will (matches the manifest resolver's
 * overwrite-on-refresh convention). On first declaration the status seeds to
 * 'declared'; on re-declaration a non-terminal status is reset to 'declared'
 * (a fresh plan restarts liveness derivation), while terminal states
 * (executed/revoked) are NOT silently re-opened — the caller must clear them.
 *
 * FK pre-create: the wallet row MUST exist (the claim/declare write-path ensures
 * it). This helper does not create the wallet — callers that might race ahead of
 * a wallet row should claim/upsert it first.
 */
export interface UpsertSuccessionInput {
  agentWallet: string;
  chain?: Chain;
  sourceType: SuccessionSourceType;
  intervalSeconds: number;
  heirs: SuccessionHeir[];
  willHash?: string | null;
}

export async function upsertSuccession(input: UpsertSuccessionInput): Promise<void> {
  const chain = input.chain ?? DEFAULT_CHAIN;
  const now = new Date().toISOString();

  // Read prior row to preserve declared_at + first-heartbeat history and to
  // refuse re-opening a terminal will via a plain re-declare.
  const existing = await getSuccession(input.agentWallet, chain);

  const row: Record<string, unknown> = {
    chain,
    agent_wallet: input.agentWallet,
    source_type: input.sourceType,
    interval_seconds: input.intervalSeconds,
    heirs: input.heirs,
    will_hash: input.willHash ?? null,
    status: 'declared' as SuccessionStatus,
    updated_at: now,
  };

  if (!existing) {
    row.declared_at = now;
  } else if (existing.status === 'executed' || existing.status === 'revoked') {
    // Don't resurrect a terminal will through a re-declare; keep the terminal
    // status + its timestamp. The plan fields still update (new heirs/interval).
    row.status = existing.status;
  }

  const { error } = await supabase
    .from('successions')
    .upsert(row, { onConflict: 'chain,agent_wallet' });

  if (error) throw error;

  // Denormalize interval onto the wallet so the Explore filter can read cadence
  // without joining. status/heartbeat_last_at are written by the heartbeat
  // worker; on first declaration seed status='declared' so the badge/feed react
  // immediately.
  const walletPatch: Record<string, unknown> = {
    heartbeat_interval_seconds: input.intervalSeconds,
    updated_at: now,
  };
  if (!existing) walletPatch.succession_status = 'declared';

  const { error: wErr } = await supabase
    .from('wallets')
    .update(walletPatch)
    .eq('chain', chain)
    .eq('address', input.agentWallet);
  if (wErr) throw wErr;
}

/**
 * List declared successions the heartbeat worker should re-evaluate. Excludes
 * terminal states (executed/revoked) — their status is a settled fact and never
 * changes from liveness derivation. Ordered by last_heartbeat ascending (NULLs
 * first) so the stalest agents are processed first under a bounded batch.
 */
export async function listSuccessionsForHeartbeat(
  limit = 500,
  chain?: Chain,
): Promise<Succession[]> {
  let q = supabase
    .from('successions')
    .select('*')
    .not('status', 'in', '("executed","revoked")');

  if (chain) q = q.eq('chain', chain);

  const { data, error } = await q
    .order('last_heartbeat_at', { ascending: true, nullsFirst: true })
    .order('agent_wallet', { ascending: true })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as Succession[];
}

/**
 * Persist a derived liveness read: writes successions.status +
 * last_heartbeat_at (+ lapsed_at when first entering 'lapsed') AND denormalizes
 * succession_status + heartbeat_last_at onto the wallet row in lockstep. Pure
 * status write — never executes or modifies a will. Idempotent.
 */
export interface ApplySuccessionLivenessInput {
  agentWallet: string;
  chain?: Chain;
  status: SuccessionStatus;
  heartbeatLastAt: string | null;
}

export async function applySuccessionLiveness(
  input: ApplySuccessionLivenessInput,
): Promise<void> {
  const chain = input.chain ?? DEFAULT_CHAIN;
  const now = new Date().toISOString();

  const succPatch: Record<string, unknown> = {
    status: input.status,
    last_heartbeat_at: input.heartbeatLastAt,
    updated_at: now,
  };
  // Stamp lapsed_at the moment we first derive 'lapsed' (observation time of the
  // succession condition being met — not a will execution).
  if (input.status === 'lapsed') succPatch.lapsed_at = now;

  const { error } = await supabase
    .from('successions')
    .update(succPatch)
    .eq('chain', chain)
    .eq('agent_wallet', input.agentWallet);
  if (error) throw error;

  const { error: wErr } = await supabase
    .from('wallets')
    .update({
      succession_status: input.status,
      heartbeat_last_at: input.heartbeatLastAt,
      updated_at: now,
    })
    .eq('chain', chain)
    .eq('address', input.agentWallet);
  if (wErr) throw wErr;
}

/**
 * Chain-scoped "last meaningful tx" timestamp for the heartbeat read. Unlike
 * getRecentTransactionsForWallet (address-only), this pins (chain, wallet) so a
 * Celo address never reads an Arc tx under the same 0x string. Returns the
 * newest tx timestamp (ISO) or null when the agent has no indexed activity.
 */
export async function getLastMeaningfulTxAt(
  agentWallet: string,
  chain: Chain = DEFAULT_CHAIN,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('transactions')
    .select('timestamp')
    .eq('chain', chain)
    .eq('wallet_address', agentWallet)
    .order('timestamp', { ascending: false })
    .limit(1);

  if (error) throw error;
  const row = (data ?? [])[0] as { timestamp: string } | undefined;
  return row ? new Date(row.timestamp).toISOString() : null;
}

// --- Bonds / Agent Bonding (read-only projection) ---------------------------
//
// AK never holds the bond and is NEVER the resolution oracle (RFC §12). These
// helpers project the escrow's public lifecycle. Demo/seeded rows carry
// is_demo=true and MUST stay visibly flagged in any payload.

/**
 * All bonds taken out on an agent (the agent is the bonded party), newest
 * first. Chain-scoped via (chain, bonded_agent_wallet) FK.
 */
export async function getBondsForAgent(
  agentWallet: string,
  chain: Chain = DEFAULT_CHAIN,
): Promise<Bond[]> {
  const { data, error } = await supabase
    .from('bonds')
    .select('*')
    .eq('chain', chain)
    .eq('bonded_agent_wallet', agentWallet)
    .order('opened_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as Bond[];
}

/**
 * Underwriting positions a wallet holds (it backs OTHER agents' bonds), joined
 * to each bond's status/amount so callers can map them into SuretyPosition and
 * render surety activity. Chain-scoped via (chain, underwriter_wallet) FK.
 */
export async function getUnderwriterPositions(
  underwriterWallet: string,
  chain: Chain = DEFAULT_CHAIN,
): Promise<Array<BondUnderwriter & { bond: Bond | null }>> {
  const { data, error } = await supabase
    .from('bond_underwriters')
    .select('*, bonds(*)')
    .eq('chain', chain)
    .eq('underwriter_wallet', underwriterWallet)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return ((data ?? []) as Array<BondUnderwriter & { bonds: Bond | null }>).map((row) => {
    const { bonds, ...rest } = row;
    return { ...rest, bond: bonds ?? null };
  });
}

/**
 * Lloyd's leaderboard read: wallets ranked by Surety Karma (the orthogonal
 * underwriter-quality axis), highest first. Only wallets that have underwritten
 * at least one bond carry a non-null surety_score, so this naturally excludes
 * everyone else. Optionally chain-filtered. Read-only projection of the
 * denormalized surety columns the bond projector maintains.
 */
export interface SuretyLeaderboardFilters {
  chain?: Chain;
}

export interface SuretyLeaderboardPage {
  wallets: Wallet[];
  total: number;
}

export async function getSuretyLeaderboard(
  limit = 25,
  offset = 0,
  filters: SuretyLeaderboardFilters = {},
): Promise<SuretyLeaderboardPage> {
  let q = supabase
    .from('wallets')
    .select('*', { count: 'exact' })
    .not('surety_score', 'is', null);

  if (filters.chain) q = q.eq('chain', filters.chain);

  const { data, error, count } = await q
    .order('surety_score', { ascending: false })
    .order('address', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return { wallets: (data ?? []) as Wallet[], total: count ?? 0 };
}

/**
 * Upsert one projected bond row, keyed on (chain, escrow_ref) — the escrow
 * contract/account id is the durable identity of a bond, so re-indexing the same
 * escrow's events is idempotent (open then later resolve updates one row). Never
 * writes funds or triggers resolution — this is a read-only projection of the
 * escrow's public lifecycle. Returns the row's id (needed to attach
 * underwriters).
 *
 * `isDemo` MUST be true for seeded rows so the UI never implies a real on-chain
 * bond before an escrow is deployed.
 */
export interface UpsertBondInput {
  chain?: Chain;
  bondedAgentWallet: string;
  beneficiary: string;
  escrowRef: string;
  taskRef?: string | null;
  amount: number;
  currency?: string;
  status: BondStatus;
  resolutionProofTx?: string | null;
  isDemo?: boolean;
  openedAt?: string | Date;
  resolvedAt?: string | Date | null;
}

export async function upsertBond(input: UpsertBondInput): Promise<string> {
  const chain = input.chain ?? DEFAULT_CHAIN;
  const row: Record<string, unknown> = {
    chain,
    bonded_agent_wallet: input.bondedAgentWallet,
    beneficiary: input.beneficiary,
    escrow_ref: input.escrowRef,
    task_ref: input.taskRef ?? null,
    amount: input.amount,
    currency: input.currency ?? 'USDC',
    status: input.status,
    resolution_proof_tx: input.resolutionProofTx ?? null,
    is_demo: input.isDemo ?? false,
  };
  if (input.openedAt !== undefined) {
    row.opened_at = typeof input.openedAt === 'string' ? input.openedAt : input.openedAt.toISOString();
  }
  if (input.resolvedAt !== undefined && input.resolvedAt !== null) {
    row.resolved_at = typeof input.resolvedAt === 'string' ? input.resolvedAt : input.resolvedAt.toISOString();
  }

  const { data, error } = await supabase
    .from('bonds')
    .upsert(row, { onConflict: 'chain,escrow_ref' })
    .select('id')
    .single();

  if (error) throw error;
  return (data as { id: string }).id;
}

/**
 * Upsert one underwriter position on a bond, keyed on
 * (bond_id, chain, underwriter_wallet). Idempotent re-index: a later resolve
 * stamps `settled` + `premium_earned` on the same row. Surety Karma derivation
 * reads these outcomes — never the underwriter's own Provider/Consumer face.
 */
export interface UpsertBondUnderwriterInput {
  bondId: string;
  chain?: Chain;
  underwriterWallet: string;
  stakeAmount: number;
  premiumEarned?: number | null;
  settled?: boolean;
}

export async function upsertBondUnderwriter(
  input: UpsertBondUnderwriterInput,
): Promise<void> {
  const chain = input.chain ?? DEFAULT_CHAIN;
  const row: Record<string, unknown> = {
    bond_id: input.bondId,
    chain,
    underwriter_wallet: input.underwriterWallet,
    stake_amount: input.stakeAmount,
    settled: input.settled ?? false,
  };
  if (input.premiumEarned !== undefined) row.premium_earned = input.premiumEarned;

  const { error } = await supabase
    .from('bond_underwriters')
    .upsert(row, { onConflict: 'bond_id,chain,underwriter_wallet' });

  if (error) throw error;
}

// --- ERC-8004 Registry Mirror (per-agent, keyed by agent_id) -----------------
//
// Backs the `erc8004_agents` / `erc8004_feedback` tables that let AK match
// 8004scan's per-network agent + feedback totals. Populated by
// src/indexer/erc8004-registry.ts via the injected persist callbacks. The
// `ScannedAgent`/`ScannedFeedback` shapes are imported type-only above.

const ERC8004_UPSERT_CHUNK = 500;

/**
 * Batch-upsert agent rows. Auto-detects whether to write the denormalized
 * feedback columns: the identity pass passes rows with no `feedback` (so those
 * columns keep their DB default / existing value), the feedback re-upsert
 * passes rows that ALL carry `feedback`. Every row in a single call therefore
 * has an identical column set — required for PostgREST's batch ON CONFLICT.
 */
export async function upsertErc8004Agents(chain: string, agents: ScannedAgent[]): Promise<number> {
  if (agents.length === 0) return 0;
  const nowIso = new Date().toISOString();
  const withFeedback = agents.every((a) => a.feedback != null);
  const rows = agents.map((a) => {
    const row: Record<string, unknown> = {
      chain,
      agent_id: a.agentId,
      owner: a.owner,
      agent_wallet: a.agentWallet,
      token_uri: a.tokenURI,
      registration: a.registration ?? null,
      registration_status: a.registrationStatus,
      metadata_score: a.metadataScore,
      last_indexed_at: nowIso,
    };
    if (withFeedback) {
      row.feedback_count = a.feedback!.count;
      row.feedback_sum = a.feedback!.sum;
      row.feedback_avg = a.feedback!.avg;
    }
    return row;
  });

  let written = 0;
  for (let i = 0; i < rows.length; i += ERC8004_UPSERT_CHUNK) {
    const part = rows.slice(i, i + ERC8004_UPSERT_CHUNK);
    const { error } = await supabase
      .from('erc8004_agents')
      .upsert(part, { onConflict: 'chain,agent_id' });
    if (error) throw error;
    written += part.length;
  }
  return written;
}

/** Batch-upsert feedback records (one row per ReputationRegistry record). */
export async function upsertErc8004Feedback(chain: string, feedback: ScannedFeedback[]): Promise<number> {
  if (feedback.length === 0) return 0;
  const nowIso = new Date().toISOString();
  const rows = feedback.map((f) => ({
    chain,
    agent_id: f.agentId,
    client: f.client,
    feedback_index: f.feedbackIndex,
    raw_value: f.rawValue,
    value: f.value,
    value_decimals: f.valueDecimals,
    tag1: f.tag1,
    tag2: f.tag2,
    revoked: f.revoked,
    indexed_at: nowIso,
  }));

  let written = 0;
  for (let i = 0; i < rows.length; i += ERC8004_UPSERT_CHUNK) {
    const part = rows.slice(i, i + ERC8004_UPSERT_CHUNK);
    const { error } = await supabase
      .from('erc8004_feedback')
      .upsert(part, { onConflict: 'chain,agent_id,client,feedback_index' });
    if (error) throw error;
    written += part.length;
  }
  return written;
}

/**
 * Per-chain registry totals (agents + feedback records) via HEAD counts — no
 * row scan, so it stays cheap as the mirror grows. Returns one entry per chain
 * that has at least one agent row.
 */
export async function getRegistryStats(
  chains: string[] = ['celo', 'arc'],
): Promise<{ chain: string; agents: number; feedbacks: number }[]> {
  const out: { chain: string; agents: number; feedbacks: number }[] = [];
  for (const chain of chains) {
    const [agentsRes, fbRes] = await Promise.all([
      supabase.from('erc8004_agents').select('*', { count: 'exact', head: true }).eq('chain', chain),
      supabase.from('erc8004_feedback').select('*', { count: 'exact', head: true }).eq('chain', chain),
    ]);
    const agents = agentsRes.count ?? 0;
    const feedbacks = fbRes.count ?? 0;
    if (agents > 0 || feedbacks > 0) out.push({ chain, agents, feedbacks });
  }
  return out;
}

/** Highest agent_id already mirrored for a chain (0 if none) — drives the
 *  incremental scan that only reads ids past the last sweep. */
export async function getMaxErc8004AgentId(chain: string): Promise<number> {
  const { data, error } = await supabase
    .from('erc8004_agents')
    .select('agent_id')
    .eq('chain', chain)
    .order('agent_id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? Number((data as { agent_id: number }).agent_id) : 0;
}

/** Read a single cached registry agent row (used by the agent-resolve route). */
export async function getErc8004Agent(
  chain: string, agentId: number,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from('erc8004_agents')
    .select('*')
    .eq('chain', chain)
    .eq('agent_id', agentId)
    .maybeSingle();
  if (error) throw error;
  return (data as Record<string, unknown>) ?? null;
}

// --- ERC-8004 AK-connected feedback ------------------------------------------
//
// The feedback AgentKarma is directly involved in on an EVM 8004 chain:
//   1. AK's own algorithmic metadata-quality attestations (AK_METADATA_TAG1),
//      signed by an AK rater wallet (AK_RATER_ADDRESSES).
//   2. Independent reviews published through AK's give-feedback UX
//      (AK_REVIEW_TAG1) — any connected wallet; AK-connected by scheme.
// Backs the "feedback AK made" list on /celo. Reads the registry mirror only
// (no live RPC) and joins each target agent to a display name + headline stats.

export interface AkConnectedFeedback {
  agentId: number;
  /** 'metadata' = AK's algorithmic attestation; 'review' = independent rater via AK UX. */
  kind: 'metadata' | 'review';
  tag2: string;
  /** Normalized value = raw / 10^valueDecimals. 0–100 scale for both schemes. */
  value: number;
  revoked: boolean;
  /** Rater address — an AK wallet for `metadata`, the third-party rater for `review`. */
  client: string;
  /** Target agent: registry display name + the /agent link address, when mirrored. */
  targetName: string | null;
  targetAddress: string | null;
  /** Target agent's headline metadata score (0–100) and total feedback count. */
  targetMetadataScore: number | null;
  targetFeedbackCount: number | null;
}

export async function getAkConnectedFeedback(
  chain: 'celo' | 'arc',
): Promise<AkConnectedFeedback[]> {
  const { data, error } = await supabase
    .from('erc8004_feedback')
    .select('agent_id, client, value, value_decimals, tag1, tag2, revoked')
    .eq('chain', chain)
    .in('tag1', [AK_METADATA_TAG1, AK_REVIEW_TAG1]);
  if (error) throw error;

  const akRaters = new Set(AK_RATER_ADDRESSES); // already lowercased
  const rows = ((data ?? []) as Array<{
    agent_id: number; client: string; value: number | string | null;
    value_decimals: number | null; tag1: string; tag2: string; revoked: boolean;
  }>).filter(
    // A metadata record only counts as AK's when an AK wallet signed it; a review
    // is AK-connected by virtue of the scheme, whoever the rater is.
    (r) => r.tag1 === AK_REVIEW_TAG1 || akRaters.has(String(r.client).toLowerCase()),
  );
  if (rows.length === 0) return [];

  // Resolve each target agent's name + display address + headline stats from the
  // mirror. Chunk defensively though AK-rated ids are few (URI cap, ADDRESS_IN_CHUNK).
  const ids = [...new Set(rows.map((r) => r.agent_id))];
  const meta = new Map<number, {
    name: string | null; address: string | null; score: number | null; count: number | null;
  }>();
  for (let i = 0; i < ids.length; i += ADDRESS_IN_CHUNK) {
    const chunk = ids.slice(i, i + ADDRESS_IN_CHUNK);
    const { data: agents, error: aErr } = await supabase
      .from('erc8004_agents')
      .select('agent_id, owner, agent_wallet, registration, metadata_score, feedback_count')
      .eq('chain', chain)
      .in('agent_id', chunk);
    if (aErr) throw aErr;
    for (const a of (agents ?? []) as Array<{
      agent_id: number; owner: string; agent_wallet: string | null;
      registration: { name?: string } | null; metadata_score: number | null; feedback_count: number | null;
    }>) {
      // Same rule as registryRowToWallet: a never-set agent wallet reads as the
      // zero address — fall back to the owner so we never link 0x000…000.
      const aw = a.agent_wallet;
      const address = aw && aw.toLowerCase() !== ZERO_ADDRESS ? aw : a.owner;
      meta.set(Number(a.agent_id), {
        name: a.registration?.name ?? null,
        address: address ?? null,
        score: a.metadata_score ?? null,
        count: a.feedback_count ?? null,
      });
    }
  }

  return rows
    .map((r) => {
      const m = meta.get(r.agent_id);
      return {
        agentId: r.agent_id,
        kind: (r.tag1 === AK_REVIEW_TAG1 ? 'review' : 'metadata') as 'metadata' | 'review',
        tag2: r.tag2,
        value: Number(r.value ?? 0) / 10 ** (r.value_decimals ?? 0),
        revoked: r.revoked,
        client: r.client,
        targetName: m?.name ?? null,
        targetAddress: m?.address ?? null,
        targetMetadataScore: m?.score ?? null,
        targetFeedbackCount: m?.count ?? null,
      };
    })
    // Live records first, then highest AK score; stable tiebreak on agentId.
    .sort((a, b) =>
      Number(a.revoked) - Number(b.revoked) || b.value - a.value || a.agentId - b.agentId,
    );
}

// --- x402 Payee Discovery (endpoint-driven self-seeder) ----------------------
//
// Backs scripts/celo-x402-discover-payees.ts + the indexer's facilitator-set
// union. See `celo_x402_payees` in schema.ts for the attribution-poisoning
// rationale behind `verified`.

/** One registry agent row reduced to the fields the payee probe needs. */
export interface Erc8004AgentLite {
  agent_id: number;
  owner: string;
  agent_wallet: string | null;
  registration: unknown | null;
}

/**
 * Page through the registry mirror for a chain, agent_id ascending. Selects
 * only the columns the endpoint probe needs (id, owner, agentWallet,
 * registration JSON). `pageSize` rows from `offset`; an empty array ends the
 * walk. ascending by agent_id so a bounded sample is deterministic + resumable.
 */
export async function listErc8004AgentsPage(
  chain: Chain,
  offset: number,
  pageSize: number,
): Promise<Erc8004AgentLite[]> {
  const { data, error } = await supabase
    .from('erc8004_agents')
    .select('agent_id, owner, agent_wallet, registration')
    .eq('chain', chain)
    .order('agent_id', { ascending: true })
    .range(offset, offset + pageSize - 1);
  if (error) throw error;
  return (data as Erc8004AgentLite[]) ?? [];
}

export interface UpsertCeloX402PayeeInput {
  /** EVM payee address (lowercased on write). */
  address: string;
  sourceAgentId: number | null;
  endpoint: string | null;
  /** Resolved Celo stablecoin contract address. */
  asset: string | null;
  /** Raw x402 network value (e.g. eip155:42220). */
  network: string | null;
  /** Self-payee (controlled by the source agent) → indexer-eligible. */
  verified: boolean;
}

/**
 * Upsert one discovered x402 payee, keyed (chain, address). Re-discovery bumps
 * `last_seen_at` and refreshes provenance. `verified` reflects the latest probe:
 * a previously-unverified address that is later self-attested by its controlling
 * agent flips to true (and vice-versa — a victim address re-declared by a
 * different agent stays false). Always writes the lowercased address so the
 * indexer's lowercased match set keys cleanly.
 */
export async function upsertCeloX402Payee(
  input: UpsertCeloX402PayeeInput,
  chain: Chain = 'celo',
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from('celo_x402_payees')
    .upsert(
      {
        chain,
        address: input.address.toLowerCase(),
        source_agent_id: input.sourceAgentId,
        endpoint: input.endpoint,
        asset: input.asset ? input.asset.toLowerCase() : null,
        network: input.network,
        verified: input.verified,
        last_seen_at: nowIso,
      },
      { onConflict: 'chain,address' },
    );
  if (error) throw error;
}

/**
 * Lowercased set of VERIFIED (self-payee) discovered payee addresses for a
 * chain — the only rows safe to feed the settlement indexer. Cross-address
 * (verified=false) declarations are excluded so a poisoned `payTo` can never
 * silently make AK index a victim's transfers.
 */
export async function getDiscoveredCeloX402Payees(
  chain: Chain = 'celo',
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('celo_x402_payees')
    .select('address')
    .eq('chain', chain)
    .eq('verified', true);
  if (error) throw error;
  const set = new Set<string>();
  for (const row of (data as { address: string }[]) ?? []) {
    set.add(row.address.toLowerCase());
  }
  return set;
}
