import { getStats, getLeaderboard } from '@/db/client';
import { StatsCards } from '@/components/karma/stats-cards';
import { LeaderboardTable } from '@/components/karma/leaderboard-table';
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

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Leaderboard</h1>
        <p className="mt-1 text-muted-foreground">
          AI agent trust scores based on x402 payment history on Solana.
        </p>
      </div>

      {dbError ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <p className="text-muted-foreground">
            Database not connected. Set{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 text-sm font-mono">
              NEXT_PUBLIC_SUPABASE_URL
            </code>{' '}
            and{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 text-sm font-mono">
              SUPABASE_SERVICE_ROLE_KEY
            </code>{' '}
            to get started.
          </p>
        </div>
      ) : (
        <>
          {stats && <StatsCards data={stats} />}

          <div className="rounded-lg border border-border/50 bg-card">
            <div className="border-b border-border/50 px-4 py-3">
              <h2 className="text-sm font-medium text-muted-foreground">
                Top Agents by Karma Score
              </h2>
            </div>
            <LeaderboardTable entries={leaderboard} />
          </div>
        </>
      )}
    </div>
  );
}
