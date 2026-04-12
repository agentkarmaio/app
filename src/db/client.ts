/**
 * Karma DB Client -- Supabase
 *
 * Env vars required:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Wallet, Transaction, TrustTier, IndexerCursor, Feedback, FeedbackRating } from './schema';

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

export async function upsertWallet(
  address: string,
  score: number,
  trustTier: TrustTier,
  txCount: number,
): Promise<void> {
  const { error } = await supabase
    .from('wallets')
    .upsert({
      address,
      score,
      trust_tier: trustTier,
      tx_count: txCount,
      last_seen: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'address' });

  if (error) throw error;
}

export async function getLeaderboard(limit = 25): Promise<Wallet[]> {
  const { data, error } = await supabase
    .from('wallets')
    .select('*')
    .gt('score', 0)
    .order('score', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as Wallet[];
}

// --- Agent Claiming ----------------------------------------------------------

export async function claimWallet(
  address: string,
  displayName: string,
  description: string | null,
  website: string | null,
  category: string | null,
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
      claimed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
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

  // Fallback: JS aggregation
  const { data, error } = await supabase
    .from('transactions')
    .select('facilitator, wallet_address, amount, timestamp');

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
): Promise<Transaction[]> {
  let query = supabase
    .from('transactions')
    .select('*')
    .order('timestamp', { ascending: false })
    .limit(limit);

  if (facilitator) {
    query = query.eq('facilitator', facilitator);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Transaction[];
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
