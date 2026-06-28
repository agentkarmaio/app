'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { LeaderboardTable, type LeaderboardEntry } from './leaderboard-table';
import { ChainFilterPill, type ChainFilter } from './chain-filter-pill';
import type {
  LivenessStatus, TrustTier, ConfidenceBadge, AutonomyLabel, Chain,
} from '@/db/schema';

const PAGE_SIZE = 25;

interface ApiEntry {
  rank: number;
  address: string;
  chain: Chain;
  displayName: string | null;
  imageUrl: string | null;
  score: number;
  trustTier: TrustTier;
  confidenceBadge?: ConfidenceBadge | null;
  autonomyScore?: number | null;
  autonomyLabel?: AutonomyLabel | null;
  txCount: number;
  lastSeen: string;
  delivery: { total: number; deliveryRate: number } | null;
  trend: number[];
}

type StatusFilter = 'All' | LivenessStatus;
type TierFilter = 'All' | TrustTier;

const STATUS_OPTIONS: StatusFilter[] = ['All', 'Active', 'Recent', 'Dormant', 'Inactive'];
const TIER_OPTIONS: TierFilter[] = ['All', 'Excellent', 'Very Good', 'Good', 'Fair', 'Poor', 'Unrated'];

export function LeaderboardWithLoadMore({
  initial,
  mode = 'full',
  totalHint,
}: {
  initial: LeaderboardEntry[];
  /**
   * `full` — infinite scroll via IntersectionObserver (used at /explore).
   * `preview` — show first page only with a "View all" CTA so this can sit
   *  above terminal page content (FAQ + footer) on the home page without
   *  fighting for scroll real estate.
   */
  mode?: 'full' | 'preview';
  /**
   * Optional initial value for `total`. Used in preview mode so the
   * "View all N agents" CTA can show a count without an extra fetch.
   */
  totalHint?: number | null;
}) {
  const isPreview = mode === 'preview';
  const [entries, setEntries] = useState<LeaderboardEntry[]>(initial);
  const [hasMore, setHasMore] = useState(!isPreview && initial.length >= PAGE_SIZE);
  const [total, setTotal] = useState<number | null>(totalHint ?? null);
  const [isPending, startTransition] = useTransition();
  const [isFiltering, setIsFiltering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFilter>('All');
  const [tier, setTier] = useState<TierFilter>('All');
  const [chain, setChain] = useState<ChainFilter>('All');
  const [pulsing, setPulsing] = useState<Set<string>>(() => new Set());
  const seenSigsRef = useRef<Set<string>>(new Set());
  const seededRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch('/api/explore?limit=15', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as {
          transactions: { wallet_address: string; tx_signature: string }[];
        };
        const txs = data.transactions ?? [];
        if (cancelled) return;

        if (!seededRef.current) {
          for (const t of txs) seenSigsRef.current.add(t.tx_signature);
          seededRef.current = true;
          return;
        }

        const freshAddresses: string[] = [];
        for (const t of txs) {
          if (!seenSigsRef.current.has(t.tx_signature)) {
            seenSigsRef.current.add(t.tx_signature);
            freshAddresses.push(t.wallet_address);
          }
        }
        if (freshAddresses.length === 0) return;

        setPulsing((prev) => {
          const next = new Set(prev);
          for (const a of freshAddresses) next.add(a);
          return next;
        });

        freshAddresses.forEach((addr) => {
          setTimeout(() => {
            setPulsing((prev) => {
              if (!prev.has(addr)) return prev;
              const next = new Set(prev);
              next.delete(addr);
              return next;
            });
          }, 1900);
        });
      } catch {}
    }

    poll();
    const interval = setInterval(poll, 8000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const fetchPage = useCallback(
    async (reset: boolean) => {
      setError(null);
      if (reset) setIsFiltering(true);
      const offset = reset ? 0 : entries.length;
      const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (status !== 'All') p.set('status', status);
      if (tier !== 'All') p.set('tier', tier);
      if (chain !== 'All') p.set('chain', chain);
      try {
        const res = await fetch(`/api/leaderboard?${p}`);
        if (!res.ok) {
          setError('Failed to load');
          return;
        }
        const data = (await res.json()) as { wallets: ApiEntry[]; total?: number };
        const next: LeaderboardEntry[] = data.wallets.map((w) => ({
          rank: w.rank,
          address: w.address,
          chain: w.chain,
          displayName: w.displayName,
          imageUrl: w.imageUrl,
          score: w.score,
          trustTier: w.trustTier,
          confidenceBadge: w.confidenceBadge ?? null,
          autonomyScore: w.autonomyScore ?? null,
          autonomyLabel: w.autonomyLabel ?? null,
          txCount: w.txCount,
          lastSeen: w.lastSeen,
          delivery: w.delivery,
          trend: w.trend,
        }));
        startTransition(() => {
          setEntries((prev) => (reset ? next : [...prev, ...next]));
          setHasMore(next.length >= PAGE_SIZE);
          setTotal(typeof data.total === 'number' ? data.total : null);
        });
      } finally {
        if (reset) setIsFiltering(false);
      }
    },
    [entries.length, status, tier, chain],
  );

  const loadMore = useCallback(() => fetchPage(false), [fetchPage]);

  const filterMounted = useRef(false);
  useEffect(() => {
    if (!filterMounted.current) {
      filterMounted.current = true;
      return;
    }
    fetchPage(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, tier, chain]);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (isPreview) return; // preview mode never lazy-loads
    if (!hasMore || isPending || !sentinelRef.current) return;
    const el = sentinelRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: '400px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, isPending, loadMore, isPreview]);

  const headerCount =
    total !== null && (status !== 'All' || tier !== 'All' || chain !== 'All')
      ? `${entries.length} / ${total} agents`
      : `${entries.length} agents`;

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
        <ChainFilterPill value={chain} onChange={setChain} />
        <span className="ml-auto flex items-center gap-1.5 text-[10px] font-[510] uppercase tracking-[0.08em] text-[#62666d] tabular-nums">
          {isFiltering && (
            <span
              aria-label="Loading"
              className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-[rgb(255_255_255/0.15)] border-t-[#d0d6e0]"
            />
          )}
          {headerCount}
        </span>
      </div>
      {entries.length === 0 && !isFiltering ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <p className="text-sm">
            {status === 'All' && tier === 'All' && chain === 'All'
              ? 'No agents yet.'
              : 'No agents match these filters.'}
          </p>
          {(status !== 'All' || tier !== 'All' || chain !== 'All') && (
            <button
              type="button"
              onClick={() => {
                setStatus('All');
                setTier('All');
                setChain('All');
              }}
              className="mt-2 text-xs text-[#8a8f98] underline underline-offset-4 hover:text-[#f7f8f8]"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div
          className={
            isFiltering
              ? 'pointer-events-none opacity-50 transition-opacity duration-150'
              : 'transition-opacity duration-150'
          }
          aria-busy={isFiltering}
        >
          <LeaderboardTable entries={entries} pulsingAddresses={pulsing} />
        </div>
      )}
      {!isPreview && hasMore && (
        <div
          ref={sentinelRef}
          className="flex items-center justify-center border-t border-[rgb(255_255_255/0.05)] px-4 py-3 text-[12px] text-[#62666d]"
        >
          {isPending ? 'Loading\u2026' : '\u00a0'}
        </div>
      )}
      {isPreview && entries.length > 0 && (
        <a
          href="/explore"
          className="group flex items-center justify-center gap-1.5 border-t border-[rgb(255_255_255/0.05)] px-4 py-3 text-[12px] font-[510] text-[#8a8f98] transition-colors hover:bg-[rgb(255_255_255/0.02)] hover:text-[#a9b0ff]"
        >
          <span>
            {total != null
              ? `View all ${total.toLocaleString()} agents`
              : 'View all agents'}
          </span>
          <span aria-hidden className="transition-transform duration-150 group-hover:translate-x-0.5">
            →
          </span>
        </a>
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
