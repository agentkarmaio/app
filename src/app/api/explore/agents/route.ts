import { NextRequest, NextResponse } from 'next/server';
import {
  getAgents,
  type AgentsExploreFilters, type AgentsExploreSort, type AgentSortField,
} from '@/db/client';
import type { TrustTier, LivenessStatus, ConfidenceBadge, AutonomyLabel, Chain } from '@/db/schema';
import { isChain } from '@/db/schema';
import { corsHeaders, corsPreflight, enforceRateLimit } from '@/lib/rate-limit';

export async function OPTIONS() {
  return corsPreflight();
}

const TIERS: TrustTier[] = ['Unrated', 'Poor', 'Fair', 'Good', 'Very Good', 'Excellent'];
const BADGES: ConfidenceBadge[] = ['receipt-backed', 'behavior-inferred', 'declared'];
const AUTONOMY: AutonomyLabel[] = ['agent-like', 'mixed', 'human-like'];
const STATUS: LivenessStatus[] = ['Active', 'Recent', 'Dormant', 'Inactive'];
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
    total,
    count: wallets.length,
    offset,
    limit,
    sort,
    wallets: wallets.map((w, i) => ({
      rank: offset + i + 1,
      address: w.address,
      chain: w.chain,
      displayName: w.display_name ?? null,
      claimed: w.claimed ?? false,
      providerScore: Number(w.provider_score ?? 0),
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
    })),
  }, {
    headers: {
      ...gate.headers,
      ...corsHeaders(),
      'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120',
    },
  });
}
