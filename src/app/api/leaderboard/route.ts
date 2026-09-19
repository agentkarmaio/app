import { NextRequest, NextResponse } from 'next/server';
import {
  getLeaderboard,
  getFeedbackSummariesForWallets,
  getScoreHistoriesForWallets,
} from '@/db/client';
import type { LivenessStatus, TrustTier } from '@/db/schema';
import { LIVENESS_STATUSES } from '@/db/schema';
import { parseChain } from '@/lib/leaderboard-params';
import { corsHeaders, corsPreflight, enforceRateLimit } from '@/lib/rate-limit';

export async function OPTIONS() {
  return corsPreflight();
}

const STATUSES: LivenessStatus[] = [...LIVENESS_STATUSES];
const TIERS: TrustTier[] = ['Unrated', 'Poor', 'Fair', 'Good', 'Very Good', 'Excellent'];

function parseStatus(v: string | null): LivenessStatus | undefined {
  return v && (STATUSES as string[]).includes(v) ? (v as LivenessStatus) : undefined;
}
function parseTier(v: string | null): TrustTier | undefined {
  return v && (TIERS as string[]).includes(v) ? (v as TrustTier) : undefined;
}

export async function GET(request: NextRequest) {
  const gate = await enforceRateLimit('leaderboard', request);
  if (!gate.ok) return gate.response;

  const { searchParams } = request.nextUrl;
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '25', 10), 100);
  const offset = Math.max(parseInt(searchParams.get('offset') ?? '0', 10), 0);
  const status = parseStatus(searchParams.get('status'));
  const tier = parseTier(searchParams.get('tier'));
  const chain = parseChain(searchParams.get('chain'));

  const { wallets, total } = await getLeaderboard(limit, offset, { status, tier, chain });
  // Mainnet native movements do not describe legacy service delivery/history.
  const addresses = wallets.filter((w) => w.chain !== 'arc-mainnet').map((w) => w.address);

  const [deliveryMap, historyMap] = await Promise.all([
    addresses.length ? getFeedbackSummariesForWallets(addresses) : Promise.resolve(null),
    addresses.length ? getScoreHistoriesForWallets(addresses) : Promise.resolve(null),
  ]);

  return NextResponse.json({
    total,
    count: wallets.length,
    offset,
    limit,
    wallets: wallets.map((w, i) => {
      const mainnet = w.chain === 'arc-mainnet';
      const delivery = mainnet ? null : deliveryMap?.get(w.address) ?? null;
      const history = mainnet ? [] : historyMap?.get(w.address) ?? [];
      const providerScore = w.provider_score != null ? Number(w.provider_score)
        : mainnet ? null : Number(w.score);
      return {
        rank: offset + i + 1,
        address: w.address,
        chain: w.chain,
        ...(mainnet ? { agentId: w.arc_agent_id ?? null } : {}),
        displayName: w.display_name ?? null,
        imageUrl: w.image_url ?? null,
        score: mainnet ? providerScore : Number(w.score),
        providerScore,
        consumerScore: w.consumer_score != null ? Number(w.consumer_score) : null,
        confidenceBadge: w.confidence_badge ?? 'declared',
        autonomyScore: w.autonomy_score != null ? Number(w.autonomy_score) : null,
        autonomyLabel: w.autonomy_label ?? null,
        trustTier: w.trust_tier,
        txCount: w.tx_count,
        lastSeen: w.last_seen,
        entityName: w.entity_name ?? null,
        delivery: delivery
          ? { total: delivery.total, deliveryRate: delivery.deliveryRate }
          : null,
        trend: history.map((h) => h.score),
      };
    }),
  }, {
    headers: {
      ...gate.headers,
      ...corsHeaders(),
      'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120',
    },
  });
}
