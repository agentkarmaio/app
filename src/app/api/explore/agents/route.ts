import { NextRequest, NextResponse } from 'next/server';
import {
  formatUsdc7, getAgents,
  type AgentsExploreFilters, type AgentsExploreSort, type AgentSortField,
} from '@/db/client';
import type { Wallet, TrustTier, LivenessStatus, ConfidenceBadge, AutonomyLabel, Chain } from '@/db/schema';
import { LIVENESS_STATUSES } from '@/db/schema';
import { isApiOnlyChain, isChain } from '@/db/schema';
import { corsHeaders, corsPreflight, enforceRateLimit } from '@/lib/rate-limit';
import { networkTag } from '@/lib/api-only-chain';

export async function OPTIONS() {
  return corsPreflight();
}

const TIERS: TrustTier[] = ['Unrated', 'Poor', 'Fair', 'Good', 'Very Good', 'Excellent'];
const BADGES: ConfidenceBadge[] = ['receipt-backed', 'behavior-inferred', 'declared'];
const AUTONOMY: AutonomyLabel[] = ['agent-like', 'mixed', 'human-like'];
const STATUS: LivenessStatus[] = [...LIVENESS_STATUSES];
const SORT_FIELDS: AgentSortField[] = [
  'provider_score', 'consumer_score', 'tx_count', 'last_seen', 'autonomy_score',
  'metric_cadence', 'metric_success_rate', 'metric_diversity', 'metric_volume', 'metric_age',
];

function csv<T extends string>(v: string | null, allowed: readonly T[]): T[] | undefined {
  if (!v) return undefined;
  const picks = v.split(',').map((s) => s.trim()).filter((s): s is T =>
    (allowed as readonly string[]).includes(s),
  );
  return picks.length ? picks : undefined;
}

function num(v: string | null, min = 0, max = 1): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, n));
}

/**
 * Inbound and outbound USDC payment totals for an API-only registry agent, aggregated in the
 * stellar_testnet_agents view from the same rows (and the same counting rule)
 * that GET /api/v2/agent/[chain]/[id]/payments serves, so the numbers equal the
 * sum of that route's `counted` payments (successful, and not an owner top-up,
 * a self-payment or a payment from a listed payer). `usdcReceived` is formatted exactly
 * like the payments route's `amount`: a decimal string with 7 decimals.
 */
function paymentTotals(w: Wallet) {
  return {
    received: Number(w.payments_received ?? 0),
    usdcReceived: formatUsdc7(String(w.payments_usdc_received ?? '0')),
    lastReceivedAt: w.payments_last_received_at ? new Date(w.payments_last_received_at).toISOString() : null,
    // Outbound: legs the agent's own address paid, successful ones only.
    sent: Number(w.payments_sent ?? 0),
    usdcSent: formatUsdc7(String(w.payments_usdc_sent ?? '0')),
    lastSentAt: w.payments_last_sent_at ? new Date(w.payments_last_sent_at).toISOString() : null,
  };
}

export async function GET(request: NextRequest) {
  const gate = await enforceRateLimit('explore', request);
  if (!gate.ok) return gate.response;

  const sp = request.nextUrl.searchParams;
  const limit = Math.min(Math.max(parseInt(sp.get('limit') ?? '25', 10), 1), 100);
  const offset = Math.max(parseInt(sp.get('offset') ?? '0', 10), 0);

  const statusList = csv(sp.get('status'), STATUS);
  const chainParam = sp.get('chain');
  const filters: AgentsExploreFilters = {
    tiers: csv(sp.get('tier'), TIERS),
    confidenceBadges: csv(sp.get('confidence'), BADGES),
    autonomyLabels: csv(sp.get('autonomy'), AUTONOMY),
    status: statusList?.[0], // single-value for now; add multi later
    claimed: sp.get('claimed') === 'true' ? true : sp.get('claimed') === 'false' ? false : undefined,
    chain: isChain(chainParam) ? (chainParam as Chain) : undefined,
    minProviderScore: num(sp.get('minScore'), 0, 100),
    minCadence: num(sp.get('minCadence')),
    minDiversity: num(sp.get('minDiversity')),
    minSuccessRate: num(sp.get('minSuccess')),
    search: sp.get('q')?.trim() || undefined,
  };

  const sortField = sp.get('sortBy');
  const sortDir = sp.get('sortDir');
  const sort: AgentsExploreSort = {
    field: (sortField && (SORT_FIELDS as string[]).includes(sortField))
      ? sortField as AgentSortField
      : 'provider_score',
    direction: sortDir === 'asc' ? 'asc' : 'desc',
  };

  const { wallets, total } = await getAgents(limit, offset, filters, sort);

  return NextResponse.json({
    // API-only networks (chain=stellar-testnet) self-describe; mainnet pages
    // keep their exact shape. Testnet is reachable ONLY via an explicit chain=.
    ...networkTag(filters.chain),
    total,
    count: wallets.length,
    offset,
    limit,
    sort,
    wallets: wallets.map((w, i) => ({
      rank: offset + i + 1,
      address: w.address,
      chain: w.chain,
      // ERC-8004 agentId for EVM/Stellar registry agents — lets the row link
      // resolve the per-agent profile (many agents share one owner address).
      agentId: w.celo_agent_id ?? w.arc_agent_id ?? w.stellar_agent_id ?? null,
      displayName: w.display_name ?? null,
      imageUrl: w.image_url ?? null,
      claimed: w.claimed ?? false,
      providerScore: w.chain === 'arc-mainnet' && w.provider_score == null ? null : Number(w.provider_score ?? 0),
      consumerScore: w.consumer_score != null ? Number(w.consumer_score) : null,
      trustTier: w.trust_tier,
      confidenceBadge: w.confidence_badge ?? 'declared',
      autonomyScore: w.autonomy_score != null ? Number(w.autonomy_score) : null,
      autonomyLabel: w.autonomy_label ?? null,
      txCount: w.tx_count,
      lastSeen: w.last_seen,
      metrics: {
        successRate: w.metric_success_rate != null ? Number(w.metric_success_rate) : null,
        diversity:   w.metric_diversity    != null ? Number(w.metric_diversity)    : null,
        volume:      w.metric_volume       != null ? Number(w.metric_volume)       : null,
        age:         w.metric_age          != null ? Number(w.metric_age)          : null,
        cadence:     w.metric_cadence      != null ? Number(w.metric_cadence)      : null,
      },
      ...(isApiOnlyChain(w.chain) ? { payments: paymentTotals(w) } : {}),
    })),
  }, {
    headers: {
      ...gate.headers,
      ...corsHeaders(),
      'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120',
    },
  });
}
