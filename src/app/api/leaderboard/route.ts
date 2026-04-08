import { NextRequest, NextResponse } from 'next/server';
import { getLeaderboard } from '@/db/client';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '25', 10), 100);

  const wallets = await getLeaderboard(limit);

  return NextResponse.json({
    count: wallets.length,
    wallets: wallets.map((w) => ({
      address: w.address,
      score: w.score,
      trustTier: w.trust_tier,
      txCount: w.tx_count,
      lastSeen: w.last_seen,
      entityName: w.entity_name ?? null,
    })),
  });
}
