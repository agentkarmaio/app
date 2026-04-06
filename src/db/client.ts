/**
 * Karma DB Client — Supabase
 *
 * Env vars required:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js';
import type { Wallet, Transaction, TrustTier } from './schema';

// ─── Supabase Client ─────────────────────────────────────────────────────────

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  return createClient(url, key);
}

export const supabase = getSupabase();

// ─── Wallet Queries ──────────────────────────────────────────────────────────

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

// ─── Transaction Queries ─────────────────────────────────────────────────────

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

export async function getAllTransactions(): Promise<Transaction[]> {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .order('timestamp', { ascending: false });

  if (error) throw error;
  return (data ?? []) as Transaction[];
}

// ─── Score Snapshots ─────────────────────────────────────────────────────────

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
      age,
    });

  if (error) throw error;
}

// ─── Stats Queries ───────────────────────────────────────────────────────────

export async function getStats() {
  const [walletsRes, txRes, tierRes] = await Promise.all([
    supabase.from('wallets').select('*', { count: 'exact', head: true }),
    supabase.from('transactions').select('amount'),
    supabase.from('wallets').select('trust_tier'),
  ]);

  if (walletsRes.error) throw walletsRes.error;
  if (txRes.error) throw txRes.error;
  if (tierRes.error) throw tierRes.error;

  const totalVolume = (txRes.data ?? []).reduce(
    (sum: number, row: { amount: number }) => sum + Number(row.amount),
    0,
  );

  const tierDistribution: Record<string, number> = {};
  for (const row of (tierRes.data ?? []) as { trust_tier: string }[]) {
    tierDistribution[row.trust_tier] = (tierDistribution[row.trust_tier] ?? 0) + 1;
  }

  return {
    totalAgents: walletsRes.count ?? 0,
    totalTransactions: txRes.data?.length ?? 0,
    totalVolumeUsdc: totalVolume,
    tierDistribution,
  };
}
