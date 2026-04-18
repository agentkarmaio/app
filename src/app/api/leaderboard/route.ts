import { NextRequest, NextResponse } from 'next/server';
import {
  getLeaderboard,
  getFeedbackSummariesForWallets,
  getScoreHistoriesForWallets,
} from '@/db/client';
import type { LivenessStatus, TrustTier } from '@/db/schema';

const STATUSES: LivenessStatus[] = ['Active', 'Recent', 'Dormant', 'Inactive'];
const TIERS: TrustTier[] = ['Unrated', 'Poor', 'Fair', 'Good', 'Very Good', 'Excellent'];

function parseStatus(v: string | null): LivenessStatus | undefined {
  return v && (STATUSES as string[]).includes(v) ? (v as LivenessStatus) : undefined;
}
function parseTier(v: string | null): TrustTier | undefined {
  return v && (TIERS as string[]).includes(v) ? (v as TrustTier) : undefined;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '25', 10), 100);
  const offset = Math.max(parseInt(searchParams.get('offset') ?? '0', 10), 0);
  const status = parseStatus(searchParams.get('status'));
  const tier = parseTier(searchParams.get('tier'));

  const { wallets, total } = await getLeaderboard(limit, offset, { status, tier });
  const addresses = wallets.map((w) => w.address);

  const [deliveryMap, historyMap] = await Promise.all([
    getFeedbackSummariesForWallets(addresses),
    getScoreHistoriesForWallets(addresses),
  ]);

  return NextResponse.json({
    total,
    count: wallets.length,
    offset,
    limit,
    wallets: wallets.map((w, i) => {
      const delivery = deliveryMap.get(w.address) ?? null;
      const history = historyMap.get(w.address) ?? [];
      return {
        rank: offset + i + 1,
        address: w.address,
        displayName: w.display_name ?? null,
        score: Number(w.score),
        providerScore: w.provider_score != null ? Number(w.provider_score) : Number(w.score),
        consumerScore: w.consumer_score != null ? Number(w.consumer_score) : null,
        confidenceBadge: w.confidence_badge ?? 'declared',
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
  });
}
