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
import { Tour } from '@/components/karma/tour';
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
      {!dbError && hasData && <Tour />}
      <Hero />

      {dbError ? (
        <div className="relative overflow-hidden rounded-lg border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.02)] p-10 text-center">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgb(245_166_35/0.08),transparent_55%)]"
          />
          <div className="relative">
            <div className="karma-catching-wrap mx-auto size-10">
              <span className="karma-catching-ring" />
              <span className="karma-catching-ring" />
              <span className="karma-catching-core" />
            </div>
            <p className="karma-catching-title mt-5 text-[15px] font-[510] text-[#f7f8f8]">
              The karma feed is catching up
            </p>
            <p className="mt-1.5 text-[13px] text-[#8a8f98]">
              We&apos;re reconnecting to the on-chain index. Refresh in a moment.
            </p>
          </div>
        </div>
      ) : (
        <>
          {stats && <StatsCards data={stats} />}

          <div
            data-tour="leaderboard"
            className="scroll-mt-24 rounded-lg border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]"
          >
            <LeaderboardWithLoadMore initial={leaderboard} />
          </div>

          {!hasData && <FacilitatorList />}
        </>
      )}
    </div>
  );
}
