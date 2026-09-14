/**
 * Read accessors behind the enriched score response (lib/karma-enrichment.ts).
 * Registry mirror + x402 payee reads keyed by the wallet address — the joins
 * the score surfaces were missing. Throw on error like every db/client
 * sibling; the best-effort catch lives in the resolver orchestrator only.
 *
 * Goes through the `supabase` proxy so the `__setSupabaseForTest` seam applies.
 */

import { ADDRESS_IN_CHUNK, supabase } from '@/db/client';
import {
  ENRICH_MAX_AGENTS,
  ENRICH_FEEDBACK_WINDOW,
  ENRICH_FLOW_WINDOW,
  normalizeAddressForChain,
  type EnrichmentAgentRow,
  type EnrichmentFeedbackRow,
  type EnrichmentPayeeRow,
} from '@/lib/karma-enrichment';
import type { Chain, TrustTier } from '@/db/schema';

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

/**
 * The two payment-flow directions for one wallet, feeding the reciprocity read
 * (scoring/reciprocity.ts).
 *
 * `transactions` is payer-face only — every indexer writes `wallet_address` =
 * payer, `counterparty` = payee — so "who pays this wallet" is the REVERSE
 * lookup on `counterparty` (served by idx_transactions_counterparty).
 *
 * Both reads are windowed to the most recent {@link ENRICH_FLOW_WINDOW} rows.
 * A popular resource server has tens of thousands of payers, and unbounded
 * per-wallet reads have twice taken this codebase down (statement timeout
 * 57014, `URI too long`). The inbound side is aggregated per payer in TS rather
 * than via a PostgREST aggregate RPC: an untracked aggregate function is what
 * produced the /api/stats PGRST202 outage, and the schema cache cannot be
 * reloaded from an app deploy on this cluster.
 *
 * `saturated` reports that a window came back full, i.e. the caller is looking
 * at a sample rather than the wallet's whole history.
 */
export async function getPaymentFlowsForAddress(
  chain: Chain,
  address: string,
): Promise<{
  outbound: Array<{ counterparty: string | null; amount: number }>;
  inbound: Array<{ payer: string; total: number; count: number }>;
  saturated: boolean;
}> {
  const addr = normalizeAddressForChain(address, chain);

  const [outRes, inRes] = await Promise.all([
    supabase
      .from('transactions')
      .select('counterparty, amount')
      .eq('chain', chain)
      .eq('wallet_address', addr)
      .order('timestamp', { ascending: false })
      .limit(ENRICH_FLOW_WINDOW),
    supabase
      .from('transactions')
      .select('wallet_address, amount')
      .eq('chain', chain)
      .eq('counterparty', addr)
      .order('timestamp', { ascending: false })
      .limit(ENRICH_FLOW_WINDOW),
  ]);
  if (outRes.error) throw outRes.error;
  if (inRes.error) throw inRes.error;

  const outRows = (outRes.data ?? []) as Array<{ counterparty: string | null; amount: string | number }>;
  const inRows = (inRes.data ?? []) as Array<{ wallet_address: string; amount: string | number }>;

  const byPayer = new Map<string, { payer: string; total: number; count: number }>();
  for (const row of inRows) {
    const key = row.wallet_address;
    const entry = byPayer.get(key) ?? { payer: key, total: 0, count: 0 };
    entry.total += Number(row.amount);
    entry.count += 1;
    byPayer.set(key, entry);
  }

  return {
    outbound: outRows.map((r) => ({ counterparty: r.counterparty, amount: Number(r.amount) })),
    inbound: [...byPayer.values()],
    saturated: outRows.length >= ENRICH_FLOW_WINDOW || inRows.length >= ENRICH_FLOW_WINDOW,
  };
}

/**
 * Receipt columns the profile's relationship rollups need. Deliberately wider
 * than {@link getPaymentFlowsForAddress}'s two columns: that read is on the
 * scoring hot path and gains nothing from the extra bytes, so the two functions
 * stay separate rather than one growing to serve both. They share the window
 * bound and the reasons for it.
 */
const ROLLUP_OUTBOUND_COLUMNS =
  'id, counterparty, facilitator, amount, timestamp, success, tx_signature';

export interface RollupOutboundRow {
  id: string;
  counterparty: string | null;
  facilitator: string;
  amount: number;
  timestamp: string;
  success: boolean;
  tx_signature: string;
}

export interface RollupInboundRow {
  wallet_address: string;
  amount: number;
  timestamp: string;
}

/**
 * The bounded receipt window behind the profile's Payment Relationships card,
 * in both directions.
 *
 * `transactions` is payer-face — every indexer writes `wallet_address` = payer,
 * `counterparty` = payee — so outbound is a `wallet_address` lookup and inbound
 * is the reverse lookup on `counterparty` (served by idx_transactions_counterparty).
 *
 * Both sides are capped at {@link ENRICH_FLOW_WINDOW}. The cap is not optional:
 * unbounded per-wallet reads have taken this codebase down twice (57014
 * statement timeout, `URI too long`), and a popular resource server has tens of
 * thousands of payers. `saturated` reports that a window came back full, so the
 * view can say "most recent N receipts" instead of implying lifetime totals.
 *
 * Rows are returned unaggregated and folded in TS (`lib/payment-rollups.ts`)
 * rather than by a PostgREST aggregate RPC — an untracked aggregate function is
 * what produced the /api/stats PGRST202 outage, and the schema cache cannot be
 * reloaded from an app deploy on this cluster.
 */
export async function getPaymentRollupsForAddress(
  chain: Chain,
  address: string,
): Promise<{
  outbound: RollupOutboundRow[];
  inbound: RollupInboundRow[];
  saturated: boolean;
}> {
  const addr = normalizeAddressForChain(address, chain);

  const [outRes, inRes] = await Promise.all([
    supabase
      .from('transactions')
      .select(ROLLUP_OUTBOUND_COLUMNS)
      .eq('chain', chain)
      .eq('wallet_address', addr)
      .order('timestamp', { ascending: false })
      .limit(ENRICH_FLOW_WINDOW),
    supabase
      .from('transactions')
      .select('wallet_address, amount, timestamp')
      .eq('chain', chain)
      .eq('counterparty', addr)
      .order('timestamp', { ascending: false })
      .limit(ENRICH_FLOW_WINDOW),
  ]);
  if (outRes.error) throw outRes.error;
  if (inRes.error) throw inRes.error;

  const outRows = (outRes.data ?? []) as unknown as Array<
    Omit<RollupOutboundRow, 'amount'> & { amount: string | number }
  >;
  const inRows = (inRes.data ?? []) as unknown as Array<
    Omit<RollupInboundRow, 'amount'> & { amount: string | number }
  >;

  return {
    // `amount` is numeric(38,18) and arrives as a string; coerce once here so
    // every consumer downstream works in numbers.
    outbound: outRows.map((r) => ({ ...r, amount: Number(r.amount) })),
    inbound: inRows.map((r) => ({ ...r, amount: Number(r.amount) })),
    saturated: outRows.length >= ENRICH_FLOW_WINDOW || inRows.length >= ENRICH_FLOW_WINDOW,
  };
}

export interface CounterpartyProfile {
  displayName: string | null;
  score: number | null;
  trustTier: TrustTier | null;
}

/**
 * Name + trust for the handful of addresses a rollup actually renders, so a
 * counterparty row can read "Acme Search · Very Good" instead of a base58 blob.
 *
 * Bounded by the caller to the visible rows (tens, not thousands) and chunked
 * at {@link ADDRESS_IN_CHUNK} regardless, because PostgREST encodes `.in()`
 * into the request URL and a long address list overflows Kong's ~8KB URI cap.
 *
 * Best-effort: a failed lookup degrades to bare addresses, never a 500 on the
 * profile. Absent key = an address AgentKarma has no wallet row for.
 */
export async function getCounterpartyProfiles(
  chain: Chain,
  addresses: string[],
): Promise<Map<string, CounterpartyProfile>> {
  const out = new Map<string, CounterpartyProfile>();
  const unique = [...new Set(addresses.map((a) => normalizeAddressForChain(a, chain)))];
  if (unique.length === 0) return out;

  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += ADDRESS_IN_CHUNK) {
    chunks.push(unique.slice(i, i + ADDRESS_IN_CHUNK));
  }

  const pages = await Promise.all(
    chunks.map((chunk) =>
      supabase
        .from('wallets')
        .select('address, display_name, score, trust_tier')
        .eq('chain', chain)
        .in('address', chunk),
    ),
  );

  for (const res of pages) {
    if (res.error || !res.data) continue; // best-effort: bare addresses still render
    for (const row of res.data as unknown as Array<{
      address: string;
      display_name: string | null;
      score: string | number | null;
      trust_tier: TrustTier | null;
    }>) {
      out.set(row.address, {
        displayName: row.display_name,
        score: row.score == null ? null : Number(row.score),
        trustTier: row.trust_tier,
      });
    }
  }

  return out;
}
