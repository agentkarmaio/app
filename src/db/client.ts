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
  Organization, OrganizationMember,
} from './schema';

// --- Supabase Client ---------------------------------------------------------
// Lazy: only instantiated on first access. Keeps `next build` from crashing
// when env vars aren't present during the Docker build step.

let _client: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
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

export async function getWallet(address: string): Promise<Wallet | null> {
  const { data, error } = await supabase
    .from('wallets')
    .select('*')
    .eq('address', address)
    .single();

  if (error && error.code === 'PGRST116') return null;
  if (error) throw error;
  return data as Wallet;
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
): Promise<void> {
  // Back-compat: when Phase-F fields aren't supplied, mirror `score` into
  // `provider_score` and default the badge to 'declared'.
  const providerScore = opts.providerScore ?? score;
  const confidenceBadge: ConfidenceBadge = opts.confidenceBadge ?? 'declared';

  const row: Record<string, unknown> = {
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
    .upsert(row, { onConflict: 'address' });

  if (error) throw error;
}

export interface LeaderboardFilters {
  status?: LivenessStatus;
  tier?: TrustTier;
}

export interface LeaderboardPage {
  wallets: Wallet[];
  total: number;
}

export async function getLeaderboard(
  limit = 25,
  offset = 0,
  filters: LeaderboardFilters = {},
): Promise<LeaderboardPage> {
  let q = supabase
    .from('wallets')
    .select('*', { count: 'exact' })
    .gt('score', 0);

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

export async function getAgents(
  limit = 25,
  offset = 0,
  filters: AgentsExploreFilters = {},
  sort: AgentsExploreSort = { field: 'provider_score', direction: 'desc' },
): Promise<LeaderboardPage> {
  let q = supabase
    .from('wallets')
    .select('*', { count: 'exact' })
    .gt('tx_count', 0);

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
    const term = filters.search.replace(/[%_]/g, '').trim();
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

// --- Agent Claiming ----------------------------------------------------------

export async function claimWallet(
  address: string,
  displayName: string,
  description: string | null,
  website: string | null,
  category: string | null,
  tempoAddress: string | null = null,
): Promise<void> {
  // Ensure the wallet row exists (upsert with minimal data if not)
  const existing = await getWallet(address);
  if (!existing) {
    const { error: insertErr } = await supabase
      .from('wallets')
      .insert({
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
        claimed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    if (insertErr) throw insertErr;
    return;
  }

  const { error } = await supabase
    .from('wallets')
    .update({
      claimed: true,
      display_name: displayName,
      description,
      website,
      category,
      tempo_address: tempoAddress,
      claimed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('address', address);

  if (error) throw error;
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

// --- Transaction Queries -----------------------------------------------------

export async function insertTransaction(
  tx: Omit<Transaction, 'id'>,
): Promise<void> {
  const { error } = await supabase
    .from('transactions')
    .upsert({
      wallet_address: tx.wallet_address,
      facilitator: tx.facilitator,
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
    wallet_address: tx.wallet_address,
    facilitator: tx.facilitator,
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
  // Supabase .in() has URL length limits; chunk into batches of 500
  for (let i = 0; i < walletAddresses.length; i += 500) {
    const chunk = walletAddresses.slice(i, i + 500);
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
  // Chunk to respect Supabase URL limits on .in() filters.
  for (let i = 0; i < addresses.length; i += 500) {
    const chunk = addresses.slice(i, i + 500);
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

  const { error: clearError } = await supabase
    .from('wallets')
    .update({ scoring_dirty_at: null })
    .in('address', addresses);
  if (clearError) throw clearError;

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
  // Try SQL function first, fall back to JS aggregation if not deployed
  const txStatsRes = await supabase.rpc('get_transaction_stats').single();
  const useRpc = !txStatsRes.error;

  const [walletsRes, tierRes] = await Promise.all([
    supabase.from('wallets').select('*', { count: 'exact', head: true }),
    supabase.from('wallets').select('trust_tier'),
  ]);

  if (walletsRes.error) throw walletsRes.error;
  if (tierRes.error) throw tierRes.error;

  let totalTransactions = 0;
  let totalVolumeUsdc = 0;

  if (useRpc) {
    const stats = txStatsRes.data as Record<string, unknown>;
    totalTransactions = Number(stats?.total_count ?? 0);
    totalVolumeUsdc = Number(stats?.total_volume ?? 0);
  } else {
    // Fallback: JS aggregation
    const { data: txData, error: txError } = await supabase
      .from('transactions')
      .select('amount');
    if (txError) throw txError;
    totalTransactions = txData?.length ?? 0;
    totalVolumeUsdc = (txData ?? []).reduce(
      (sum: number, row: { amount: number }) => sum + Number(row.amount), 0,
    );
  }

  const tierDistribution: Record<string, number> = {};
  for (const row of (tierRes.data ?? []) as { trust_tier: string }[]) {
    tierDistribution[row.trust_tier] = (tierDistribution[row.trust_tier] ?? 0) + 1;
  }

  return {
    totalAgents: walletsRes.count ?? 0,
    totalTransactions,
    totalVolumeUsdc,
    tierDistribution,
  };
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

  for (let i = 0; i < addresses.length; i += 500) {
    const chunk = addresses.slice(i, i + 500);
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

// --- Indexer Cursors ----------------------------------------------------------

export async function getCursor(facilitator: string): Promise<IndexerCursor | null> {
  const { data, error } = await supabase
    .from('indexer_cursors')
    .select('*')
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
): Promise<void> {
  const { error } = await supabase
    .from('indexer_cursors')
    .upsert({
      facilitator,
      last_signature: lastSignature,
      last_slot: lastSlot ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'facilitator' });

  if (error) throw error;
}

// --- Signal Events (Phase F) -------------------------------------------------

export interface InsertSignalEventInput {
  agentWallet: string;
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
      onConflict: 'agent_wallet,kind,tx_ref',
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
        onConflict: 'agent_wallet,kind,tx_ref',
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

  for (let i = 0; i < agentWallets.length; i += 500) {
    const chunk = agentWallets.slice(i, i + 500);
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

  for (let i = 0; i < txSignatures.length; i += 500) {
    const chunk = txSignatures.slice(i, i + 500);
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

  for (let i = 0; i < agentWallets.length; i += 500) {
    const chunk = agentWallets.slice(i, i + 500);
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

  for (let i = 0; i < walletAddresses.length; i += 500) {
    const chunk = walletAddresses.slice(i, i + 500);
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
