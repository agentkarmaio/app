import { Suspense } from 'react';
import { cachedStats, cachedLeaderboardEntries } from '@/db/cached';
import { StatsCards } from '@/components/karma/stats-cards';
import { LeaderboardWithLoadMore } from '@/components/karma/leaderboard-with-load-more';
import { Hero } from '@/components/karma/hero';
import { FacilitatorList } from '@/components/karma/facilitator-list';
import { BuiltWith } from '@/components/karma/built-with';
import { Tour } from '@/components/karma/tour';
import { KarmaCatchingUp } from '@/components/karma/karma-catching-up';
import type { LeaderboardEntry } from '@/components/karma/leaderboard-table';

export const revalidate = 30;

export default function HomePage() {
  return (
    <div className="space-y-10">
      <Hero />
      <Suspense fallback={<StatsSkeleton />}>
        <StatsSection />
      </Suspense>
      <BuiltWith />
      <Suspense fallback={<LeaderboardSkeleton />}>
        <LeaderboardSection />
      </Suspense>
    </div>
  );
}

async function StatsSection() {
  try {
    const stats = await cachedStats();
    return stats ? <StatsCards data={stats} /> : null;
  } catch {
    return null;
  }
}

async function LeaderboardSection() {
  let leaderboard: LeaderboardEntry[] = [];
  let dbError = false;
  try {
    leaderboard = await cachedLeaderboardEntries();
  } catch {
    dbError = true;
  }

  if (dbError) return <KarmaCatchingUp />;

  const hasData = leaderboard.length > 0;
  return (
    <>
      {hasData && <Tour />}
      <div
        data-tour="leaderboard"
        className="scroll-mt-24 rounded-lg border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]"
      >
        <LeaderboardWithLoadMore initial={leaderboard} />
      </div>
      {!hasData && <FacilitatorList />}
    </>
  );
}

function StatsSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-24 w-full animate-pulse rounded-lg bg-[rgb(255_255_255/0.03)]" />
      ))}
    </div>
  );
}

function LeaderboardSkeleton() {
  return (
    <div className="rounded-lg border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
      <div className="border-b border-[rgb(255_255_255/0.05)] px-4 py-3">
        <div className="h-4 w-40 animate-pulse rounded bg-[rgb(255_255_255/0.04)]" />
      </div>
      <div className="divide-y divide-[rgb(255_255_255/0.05)]">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="h-4 w-56 animate-pulse rounded bg-[rgb(255_255_255/0.04)]" />
            <div className="h-4 w-20 animate-pulse rounded bg-[rgb(255_255_255/0.04)]" />
          </div>
        ))}
      </div>
    </div>
  );
}
