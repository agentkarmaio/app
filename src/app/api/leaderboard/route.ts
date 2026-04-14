import { NextRequest, NextResponse } from 'next/server';
import {
  getLeaderboard,
  getFeedbackSummariesForWallets,
  getScoreHistoriesForWallets,
} from '@/db/client';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '25', 10), 100);
  const offset = Math.max(parseInt(searchParams.get('offset') ?? '0', 10), 0);

  const wallets = await getLeaderboard(limit, offset);
  const addresses = wallets.map((w) => w.address);

  const [deliveryMap, historyMap] = await Promise.all([
    getFeedbackSummariesForWallets(addresses),
    getScoreHistoriesForWallets(addresses),
  ]);

  return NextResponse.json({
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
