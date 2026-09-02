/**
 * Read accessors behind the enriched score response (lib/karma-enrichment.ts).
 * Registry mirror + x402 payee reads keyed by the wallet address — the joins
 * the score surfaces were missing. Throw on error like every db/client
 * sibling; the best-effort catch lives in the resolver orchestrator only.
 *
 * Goes through the `supabase` proxy so the `__setSupabaseForTest` seam applies.
 */

import { supabase } from '@/db/client';
import {
  ENRICH_MAX_AGENTS,
  ENRICH_FEEDBACK_WINDOW,
  normalizeAddressForChain,
  type EnrichmentAgentRow,
  type EnrichmentFeedbackRow,
  type EnrichmentPayeeRow,
} from '@/lib/karma-enrichment';
import type { Chain } from '@/db/schema';

const AGENT_COLUMNS =
  'chain, agent_id, owner, agent_wallet, token_uri, registration, registration_status, metadata_score, feedback_count, feedback_avg';

/**
 * Registry agents an address controls on one chain (as owner OR agentWallet),
 * metadata_score-desc, capped, with the uncapped total. Address casing follows
 * the chain (EVM rows are lowercase; Solana/Stellar are case-sensitive).
 */
export async function getRegistryAgentsForAddress(
  chain: Chain,
  address: string,
  limit = ENRICH_MAX_AGENTS,
): Promise<{ rows: EnrichmentAgentRow[]; total: number }> {
  const addr = normalizeAddressForChain(address, chain);
  const { data, error, count } = await supabase
    .from('erc8004_agents')
    .select(AGENT_COLUMNS, { count: 'exact' })
    .eq('chain', chain)
    .or(`owner.eq.${addr},agent_wallet.eq.${addr}`)
    .order('metadata_score', { ascending: false })
    .order('agent_id', { ascending: true })
    .limit(limit);
  if (error) throw error;
  const rows = ((data ?? []) as unknown as EnrichmentAgentRow[]);
  return { rows, total: count ?? rows.length };
}

/** Newest-first feedback window for a small set of agent ids on one chain. */
export async function getRegistryFeedbackForAgents(
  chain: Chain,
  agentIds: number[],
  limit = ENRICH_FEEDBACK_WINDOW,
): Promise<EnrichmentFeedbackRow[]> {
  if (agentIds.length === 0) return [];
  const { data, error } = await supabase
    .from('erc8004_feedback')
    .select('agent_id, client, feedback_index, value, value_decimals, tag1, tag2, revoked, indexed_at')
    .eq('chain', chain)
    .in('agent_id', agentIds)
    .order('indexed_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as unknown as EnrichmentFeedbackRow[]);
}

/** Discovered x402 payee rows for an address (read-only; never probed here). */
export async function getX402PayeesForAddress(
  chain: Chain,
  address: string,
): Promise<EnrichmentPayeeRow[]> {
  const { data, error } = await supabase
    .from('celo_x402_payees')
    .select('chain, address, source_agent_id, endpoint, asset, network, verified, discovered_at, last_seen_at')
    .eq('chain', chain)
    .eq('address', normalizeAddressForChain(address, chain))
    .order('last_seen_at', { ascending: false })
    .limit(ENRICH_MAX_AGENTS);
  if (error) throw error;
  return ((data ?? []) as unknown as EnrichmentPayeeRow[]);
}
