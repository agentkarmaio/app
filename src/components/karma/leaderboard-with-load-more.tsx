'use client';

import { useMemo, useState, useTransition } from 'react';
import { LeaderboardTable, type LeaderboardEntry } from './leaderboard-table';
import { getLivenessStatus, type LivenessStatus, type TrustTier } from '@/db/schema';

const PAGE_SIZE = 50;

interface ApiEntry {
  rank: number;
  address: string;
  displayName: string | null;
  score: number;
  trustTier: TrustTier;
  txCount: number;
  lastSeen: string;
  delivery: { total: number; deliveryRate: number } | null;
  trend: number[];
}

type StatusFilter = 'All' | LivenessStatus;
type TierFilter = 'All' | TrustTier;

const STATUS_OPTIONS: StatusFilter[] = ['All', 'Active', 'Recent', 'Dormant', 'Inactive'];
const TIER_OPTIONS: TierFilter[] = ['All', 'Excellent', 'Very Good', 'Good', 'Fair', 'Poor', 'Unrated'];

export function LeaderboardWithLoadMore({ initial }: { initial: LeaderboardEntry[] }) {
  const [entries, setEntries] = useState<LeaderboardEntry[]>(initial);
  const [hasMore, setHasMore] = useState(initial.length >= PAGE_SIZE);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFilter>('All');
  const [tier, setTier] = useState<TierFilter>('All');

  async function loadMore() {
    setError(null);
    const res = await fetch(`/api/leaderboard?limit=${PAGE_SIZE}&offset=${entries.length}`);
    if (!res.ok) {
      setError('Failed to load more');
      return;
    }
    const data = (await res.json()) as { wallets: ApiEntry[] };
    const next: LeaderboardEntry[] = data.wallets.map((w) => ({
      rank: w.rank,
      address: w.address,
      displayName: w.displayName,
      score: w.score,
      trustTier: w.trustTier,
      txCount: w.txCount,
      lastSeen: w.lastSeen,
      delivery: w.delivery,
      trend: w.trend,
    }));
    startTransition(() => {
      setEntries((prev) => [...prev, ...next]);
      setHasMore(next.length >= PAGE_SIZE);
    });
  }

  const filtered = useMemo(() => {
    if (status === 'All' && tier === 'All') return entries;
    return entries.filter((e) => {
      if (tier !== 'All' && e.trustTier !== tier) return false;
      if (status !== 'All' && getLivenessStatus(e.lastSeen) !== status) return false;
      return true;
    });
  }, [entries, status, tier]);

  const hiddenCount = entries.length - filtered.length;

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-[rgb(255_255_255/0.05)] px-4 py-2">
        <h2 className="text-[12px] font-[510] text-[#d0d6e0] tracking-[-0.12px]">
          Leaderboard
        </h2>
        <span aria-hidden className="h-3 w-px bg-[rgb(255_255_255/0.08)]" />
        <FilterGroup
          label="Status"
          value={status}
          options={STATUS_OPTIONS}
          onChange={setStatus}
        />
        <FilterGroup
          label="Tier"
          value={tier}
          options={TIER_OPTIONS}
          onChange={setTier}
        />
        <span className="ml-auto text-[10px] font-[510] uppercase tracking-[0.08em] text-[#62666d] tabular-nums">
          {hiddenCount > 0
            ? `${filtered.length} / ${entries.length}`
            : `${entries.length} agents`}
        </span>
      </div>
      {filtered.length === 0 && entries.length > 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <p className="text-sm">No agents match these filters.</p>
          <button
            type="button"
            onClick={() => {
              setStatus('All');
              setTier('All');
            }}
            className="mt-2 text-xs text-[#8a8f98] underline underline-offset-4 hover:text-[#f7f8f8]"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <LeaderboardTable entries={filtered} />
      )}
      {hasMore && (
        <div className="flex items-center justify-center border-t border-[rgb(255_255_255/0.05)] px-4 py-3">
          <button
            type="button"
            onClick={loadMore}
            disabled={isPending}
            className="rounded-md border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] px-3 py-1.5 text-[13px] font-[510] text-[#d0d6e0] transition-colors hover:bg-[rgb(255_255_255/0.04)] hover:text-[#f7f8f8] disabled:opacity-50"
          >
            {isPending ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
      {error && (
        <p className="px-4 pb-3 text-center text-[12px] text-red-400/80">{error}</p>
      )}
    </>
  );
}

function FilterGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] font-[510] uppercase tracking-[0.08em] text-[#62666d]">
        {label}
      </span>
      <div className="flex items-center">
        {options.map((opt) => {
          const active = opt === value;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              className={
                active
                  ? 'rounded-[5px] bg-[rgb(255_255_255/0.06)] px-1.5 py-0.5 text-[11px] font-[510] text-[#f7f8f8]'
                  : 'rounded-[5px] px-1.5 py-0.5 text-[11px] font-[510] text-[#8a8f98] transition-colors hover:text-[#f7f8f8]'
              }
            >
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}
