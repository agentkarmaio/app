import { getStats, getLeaderboard } from '@/db/client';
import { StatsCards } from '@/components/karma/stats-cards';
import { LeaderboardTable } from '@/components/karma/leaderboard-table';
import { WalletSearch } from '@/components/karma/wallet-search';
import { FacilitatorList } from '@/components/karma/facilitator-list';
import type { LeaderboardEntry } from '@/components/karma/leaderboard-table';
import type { TrustTier } from '@/db/schema';

export default async function HomePage() {
  let stats = null;
  let leaderboard: LeaderboardEntry[] = [];
  let dbError = false;

  try {
    const [statsData, wallets] = await Promise.all([
      getStats(),
      getLeaderboard(50),
    ]);

    stats = statsData;
    leaderboard = wallets.map((w, i) => ({
      rank: i + 1,
      address: w.address,
      score: Number(w.score),
      trustTier: w.trust_tier as TrustTier,
      txCount: w.tx_count,
      lastSeen: w.last_seen,
    }));
  } catch {
    dbError = true;
  }

  const hasData = leaderboard.length > 0;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[32px] font-[510] leading-tight tracking-[-0.704px] text-[#f7f8f8]">
            Leaderboard
          </h1>
          <p className="mt-1.5 text-[15px] text-[#8a8f98] tracking-[-0.165px]">
            AI agent trust scores based on x402 payment history on Solana.
          </p>
        </div>
        <WalletSearch />
      </div>

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
            <div className="border-b border-[rgb(255_255_255/0.05)] px-4 py-3">
              <h2 className="text-[13px] font-[510] text-[#62666d] tracking-[-0.13px]">
                Top Agents by Karma Score
              </h2>
            </div>
            <LeaderboardTable entries={leaderboard} />
          </div>

          {!hasData && <FacilitatorList />}
        </>
      )}
    </div>
  );
}
