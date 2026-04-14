import {
  getStats,
  getLeaderboard,
  getFeedbackSummariesForWallets,
  getScoreHistoriesForWallets,
} from '@/db/client';
import { StatsCards } from '@/components/karma/stats-cards';
import { LeaderboardWithLoadMore } from '@/components/karma/leaderboard-with-load-more';
import { Hero } from '@/components/karma/hero';
import { FacilitatorList } from '@/components/karma/facilitator-list';
import type { LeaderboardEntry } from '@/components/karma/leaderboard-table';
import type { TrustTier } from '@/db/schema';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  let stats = null;
  let leaderboard: LeaderboardEntry[] = [];
  let dbError = false;

  try {
    const [statsData, page] = await Promise.all([
      getStats(),
      getLeaderboard(25),
    ]);
    stats = statsData;
    const wallets = page.wallets;

    const addresses = wallets.map((w) => w.address);
    const [deliveryMap, historyMap] = await Promise.all([
      getFeedbackSummariesForWallets(addresses),
      getScoreHistoriesForWallets(addresses),
    ]);

    leaderboard = wallets.map((w, i) => {
      const delivery = deliveryMap.get(w.address) ?? null;
      const history = historyMap.get(w.address) ?? [];
      return {
        rank: i + 1,
        address: w.address,
        displayName: w.display_name,
        score: Number(w.score),
        trustTier: w.trust_tier as TrustTier,
        txCount: w.tx_count,
        lastSeen: w.last_seen,
        delivery: delivery
          ? { total: delivery.total, deliveryRate: delivery.deliveryRate }
          : null,
        trend: history.map((h) => h.score),
      };
    });
  } catch {
    dbError = true;
  }

  const hasData = leaderboard.length > 0;

  return (
    <div className="space-y-10">
      <Hero />

      {dbError ? (
        <div className="rounded-lg border border-dashed border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] p-12 text-center">
          <p className="text-[#8a8f98] text-[15px]">
            Database not connected. Set{' '}
            <code className="rounded bg-[rgb(255_255_255/0.05)] px-1.5 py-0.5 text-[13px] font-mono text-[#d0d6e0]">
              NEXT_PUBLIC_SUPABASE_URL
            </code>{' '}
            and{' '}
            <code className="rounded bg-[rgb(255_255_255/0.05)] px-1.5 py-0.5 text-[13px] font-mono text-[#d0d6e0]">
              SUPABASE_SERVICE_ROLE_KEY
            </code>{' '}
            to get started.
          </p>
        </div>
      ) : (
        <>
          {stats && <StatsCards data={stats} />}

          <div className="rounded-lg border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
            <LeaderboardWithLoadMore initial={leaderboard} />
          </div>

          {!hasData && <FacilitatorList />}
        </>
      )}
    </div>
  );
}
