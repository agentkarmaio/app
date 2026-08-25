'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowDown, ArrowUp, ChevronsUpDown, Search, SlidersHorizontal, Verified, X,
} from 'lucide-react';
import { WalletAddress } from '@/components/karma/wallet-address';
import { TierBadge } from '@/components/karma/tier-badge';
import { ConfidenceBadge as ConfidenceBadgeChip } from '@/components/karma/confidence-badge';
import { AutonomyChip } from '@/components/karma/autonomy-chip';
import { ChainBadge } from '@/components/karma/chain-badge';
import { AgentAvatar } from '@/components/karma/agent-avatar';
import { ChainFilterPill, type ChainFilter } from '@/components/karma/chain-filter-pill';
import { LivenessIndicator } from '@/components/karma/liveness-indicator';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { agentHref } from '@/lib/agent-href';
import { UI_DEFAULT_CHAIN } from '@/lib/chain-meta';
import type { TrustTier, ConfidenceBadge, AutonomyLabel, Chain } from '@/db/schema';
import { isChain } from '@/db/schema';

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;
type PageSize = typeof PAGE_SIZE_OPTIONS[number];

function clampPageSize(raw: string | null): PageSize {
  const n = parseInt(raw ?? '', 10);
  if (PAGE_SIZE_OPTIONS.includes(n as PageSize)) return n as PageSize;
  return DEFAULT_PAGE_SIZE;
}

type AgentSortField =
  | 'provider_score' | 'consumer_score' | 'tx_count' | 'last_seen'
  | 'autonomy_score' | 'metric_cadence' | 'metric_success_rate'
  | 'metric_diversity' | 'metric_volume' | 'metric_age';

const SORT_LABELS: Record<AgentSortField, string> = {
  provider_score:       'Karma',
  consumer_score:       'Consumer',
  autonomy_score:       'Autonomy',
  metric_cadence:       'Cadence',
  metric_success_rate:  'Success',
  metric_diversity:     'Diversity',
  metric_volume:        'Activity & size',
  metric_age:           'Account age',
  tx_count:             'Transactions',
  last_seen:            'Last active',
};

const SORT_FIELDS: AgentSortField[] = Object.keys(SORT_LABELS) as AgentSortField[];

const TIER_OPTIONS: TrustTier[] = ['Excellent', 'Very Good', 'Good', 'Fair', 'Poor', 'Unrated'];
const BADGE_OPTIONS: ConfidenceBadge[] = ['receipt-backed', 'behavior-inferred', 'declared'];
const AUTONOMY_OPTIONS: AutonomyLabel[] = ['agent-like', 'mixed', 'human-like'];

const BADGE_LABEL: Record<ConfidenceBadge, string> = {
  'receipt-backed':    'Receipt-backed',
  'behavior-inferred': 'Behavior-inferred',
  'declared':          'Declared only',
};

interface ApiEntry {
  rank: number;
  address: string;
  chain: Chain;
  agentId?: number | null;
  displayName: string | null;
  imageUrl: string | null;
  claimed: boolean;
  providerScore: number;
  consumerScore: number | null;
  trustTier: TrustTier;
  confidenceBadge: ConfidenceBadge;
  autonomyScore: number | null;
  autonomyLabel: AutonomyLabel | null;
  txCount: number;
  lastSeen: string;
  metrics: {
    successRate: number | null;
    diversity: number | null;
    volume: number | null;
    age: number | null;
    cadence: number | null;
  };
}

function parseArr<T extends string>(sp: URLSearchParams, key: string, allowed: readonly T[]): T[] {
  const raw = sp.get(key);
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter((s): s is T =>
    (allowed as readonly string[]).includes(s),
  );
}

function parseNum(sp: URLSearchParams, key: string): number | null {
  const v = sp.get(key);
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function AgentsExplorer() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const filters = useMemo(() => {
    // No `?chain=` lands on UI_DEFAULT_CHAIN, not every chain — the explorer
    // opens on one chain's population instead of a mixed list. 'All' is an
    // explicit opt-out and must be encoded (`chain=all`), since an absent param
    // now means the default chain.
    const chainRaw = searchParams.get('chain');
    const chain: ChainFilter = chainRaw === 'all' ? 'All'
      : isChain(chainRaw) ? (chainRaw as Chain)
      : UI_DEFAULT_CHAIN;
    return {
      tiers:            parseArr(searchParams, 'tier', TIER_OPTIONS),
      confidenceBadges: parseArr(searchParams, 'confidence', BADGE_OPTIONS),
      autonomyLabels:   parseArr(searchParams, 'autonomy', AUTONOMY_OPTIONS),
      claimed:  searchParams.get('claimed') === 'true' ? true
              : searchParams.get('claimed') === 'false' ? false : null,
      chain,
      minScore:       parseNum(searchParams, 'minScore'),
      minCadence:     parseNum(searchParams, 'minCadence'),
      minDiversity:   parseNum(searchParams, 'minDiversity'),
      minSuccessRate: parseNum(searchParams, 'minSuccess'),
      search: searchParams.get('q') ?? '',
      sortBy:  (searchParams.get('sortBy')  ?? 'provider_score') as AgentSortField,
      sortDir: (searchParams.get('sortDir') ?? 'desc') as 'asc' | 'desc',
      pageSize: clampPageSize(searchParams.get('per')),
    };
  }, [searchParams]);

  const filterKey = searchParams.toString();

  const [entries, setEntries] = useState<ApiEntry[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState(filters.search);
  const firstMountRef = useRef(true);
  const [sortOpen, setSortOpen] = useState(false);

  // Build query-string for the API from current URL params.
  const apiQuery = useMemo(() => {
    const p = new URLSearchParams();
    if (filters.tiers.length)            p.set('tier',       filters.tiers.join(','));
    if (filters.confidenceBadges.length) p.set('confidence', filters.confidenceBadges.join(','));
    if (filters.autonomyLabels.length)   p.set('autonomy',   filters.autonomyLabels.join(','));
    if (filters.claimed != null)         p.set('claimed',    String(filters.claimed));
    if (filters.chain !== 'All')         p.set('chain',      filters.chain);
    if (filters.minScore != null)        p.set('minScore',       String(filters.minScore));
    if (filters.minCadence != null)      p.set('minCadence',     String(filters.minCadence));
    if (filters.minDiversity != null)    p.set('minDiversity',   String(filters.minDiversity));
    if (filters.minSuccessRate != null)  p.set('minSuccess',     String(filters.minSuccessRate));
    if (filters.search)                  p.set('q', filters.search);
    p.set('sortBy',  filters.sortBy);
    p.set('sortDir', filters.sortDir);
    return p;
  }, [filters]);

  // Fetch whenever filter/sort URL changes; reset to offset 0.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const q = new URLSearchParams(apiQuery);
    q.set('limit',  String(filters.pageSize));
    q.set('offset', '0');
    fetch(`/api/explore/agents?${q.toString()}`, { signal: controller.signal, cache: 'no-store' })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data: { wallets: ApiEntry[]; total: number }) => {
        if (cancelled) return;
        setEntries(data.wallets);
        setTotal(data.total);
        setOffset(data.wallets.length);
      })
      .catch((err: Error) => {
        if (cancelled || err.name === 'AbortError') return;
        setError(err.message);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  useEffect(() => {
    if (firstMountRef.current) { firstMountRef.current = false; return; }
    setSearchInput(filters.search);
  }, [filters.search]);

  const updateParams = useCallback((mutate: (p: URLSearchParams) => void) => {
    const next = new URLSearchParams(searchParams);
    mutate(next);
    if (next.get('tab') == null) next.set('tab', 'agents');
    startTransition(() => {
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    });
  }, [pathname, router, searchParams]);

  const toggleIn = useCallback(<T extends string>(key: string, allowed: readonly T[], v: T) => {
    const current = parseArr(searchParams, key, allowed);
    const next = current.includes(v) ? current.filter((x) => x !== v) : [...current, v];
    updateParams((p) => {
      if (next.length) p.set(key, next.join(','));
      else p.delete(key);
    });
  }, [searchParams, updateParams]);

  const setSort = useCallback((field: AgentSortField) => {
    updateParams((p) => {
      if (filters.sortBy === field) {
        p.set('sortDir', filters.sortDir === 'desc' ? 'asc' : 'desc');
      } else {
        p.set('sortBy', field);
        p.set('sortDir', 'desc');
      }
    });
  }, [filters.sortBy, filters.sortDir, updateParams]);

  const setClaimed = useCallback((v: boolean | null) => {
    updateParams((p) => {
      if (v == null) p.delete('claimed');
      else p.set('claimed', String(v));
    });
  }, [updateParams]);

  const setChain = useCallback((v: ChainFilter) => {
    updateParams((p) => {
      if (v === 'All') p.set('chain', 'all');
      else if (v === UI_DEFAULT_CHAIN) p.delete('chain');
      else p.set('chain', v);
    });
  }, [updateParams]);

  const commitSearch = useCallback(() => {
    updateParams((p) => {
      const q = searchInput.trim();
      if (q) p.set('q', q); else p.delete('q');
    });
  }, [searchInput, updateParams]);

  const resetAll = useCallback(() => {
    setSearchInput('');
    startTransition(() => {
      router.replace(`${pathname}?tab=agents`, { scroll: false });
    });
  }, [pathname, router]);

  const loadMore = useCallback(async () => {
    if (loading || total == null || entries.length >= total) return;
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams(apiQuery);
      q.set('limit',  String(filters.pageSize));
      q.set('offset', String(offset));
      const r = await fetch(`/api/explore/agents?${q.toString()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { wallets: ApiEntry[]; total: number };
      setEntries((prev) => [...prev, ...data.wallets]);
      setOffset((prev) => prev + data.wallets.length);
      setTotal(data.total);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiQuery, entries.length, loading, offset, total]);

  const activeCount =
    filters.tiers.length +
    filters.confidenceBadges.length +
    filters.autonomyLabels.length +
    (filters.claimed != null ? 1 : 0) +
    (filters.minScore != null ? 1 : 0) +
    (filters.minCadence != null ? 1 : 0) +
    (filters.minDiversity != null ? 1 : 0) +
    (filters.minSuccessRate != null ? 1 : 0) +
    (filters.search ? 1 : 0);

  const filterPanel = (
    <FilterPanel
      filters={filters}
      onToggleTier={(t) => toggleIn('tier', TIER_OPTIONS, t)}
      onToggleConfidence={(b) => toggleIn('confidence', BADGE_OPTIONS, b)}
      onToggleAutonomy={(a) => toggleIn('autonomy', AUTONOMY_OPTIONS, a)}
      onClaimed={setClaimed}
      onThreshold={(k, v) => updateParams((p) => {
        if (v == null) p.delete(k); else p.set(k, String(v));
      })}
      onReset={resetAll}
      activeCount={activeCount}
    />
  );

  return (
    <div className="grid gap-8 lg:grid-cols-[200px_minmax(0,1fr)]">
      {/* Desktop sticky filter rail */}
      <aside className="hidden lg:block">
        <div className="sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto -mr-2 pr-2">
          {filterPanel}
        </div>
      </aside>

      <div className="space-y-3 min-w-0">
        {/* Chain filter pill */}
        <ChainFilterPill value={filters.chain} onChange={setChain} />

        {/* Toolbar */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-[#62666d]" />
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitSearch();
                if (e.key === 'Escape') { setSearchInput(''); updateParams((p) => p.delete('q')); }
              }}
              onBlur={commitSearch}
              placeholder="Search address or display name"
              className="w-full h-9 bg-transparent border border-[rgb(255_255_255/0.08)] rounded-md pl-9 pr-3 text-[13px] text-[#f7f8f8] placeholder-[#62666d] outline-none focus:border-[#5e6ad2]/50 focus:bg-[rgb(94_106_210/0.04)] transition-colors"
            />
          </div>

          {/* Mobile filter trigger */}
          <Sheet>
            <SheetTrigger className="lg:hidden h-9 inline-flex items-center gap-1.5 px-3 border border-[rgb(255_255_255/0.08)] rounded-md text-[12px] text-[#d0d6e0] hover:bg-[rgb(255_255_255/0.03)] transition-colors">
              <SlidersHorizontal className="size-3.5" />
              Filters
              {activeCount > 0 && (
                <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-[590] tabular-nums rounded-full bg-[#5e6ad2]/20 text-[#a8b0ff]">
                  {activeCount}
                </span>
              )}
            </SheetTrigger>
            <SheetContent side="left" className="w-[300px] sm:max-w-sm p-5 border-r border-[rgb(255_255_255/0.08)] bg-[#0b0c0e]">
              {filterPanel}
            </SheetContent>
          </Sheet>

          <SortMenu
            open={sortOpen}
            onOpenChange={setSortOpen}
            sortBy={filters.sortBy}
            sortDir={filters.sortDir}
            onPick={(f) => { setSort(f); setSortOpen(false); }}
            onToggleDir={() => updateParams((p) => p.set('sortDir', filters.sortDir === 'desc' ? 'asc' : 'desc'))}
          />
        </div>

        {/* Meta row: result count · pending indicator · per-page selector */}
        <div className="flex items-center justify-between gap-3 text-[11px] text-[#62666d] h-5">
          <span className="tabular-nums">
            {total != null
              ? `${total.toLocaleString()} ${total === 1 ? 'agent' : 'agents'}`
              : ' '}
          </span>
          <div className="flex items-center gap-3">
            {isPending && <span className="text-[#62666d]">Updating…</span>}
            <PageSizeSelector
              value={filters.pageSize}
              onChange={(n) =>
                updateParams((p) => {
                  if (n === DEFAULT_PAGE_SIZE) p.delete('per');
                  else p.set('per', String(n));
                })
              }
            />
          </div>
        </div>

        {/* Table */}
        <div className="rounded-lg border border-[rgb(255_255_255/0.06)] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.015)]">
                  <Th className="w-10">#</Th>
                  <Th>Agent</Th>
                  <ThSort field="provider_score" filters={filters} onSort={setSort} align="right" title="Ranked by evidence weight: declared-only scores count x0.7, so a declared 100 ranks below an observed 80.">Karma</ThSort>
                  <Th align="left">Tier</Th>
                  <Th align="left">Confidence</Th>
                  <ThSort field="autonomy_score" filters={filters} onSort={setSort} align="left">Autonomy</ThSort>
                  <ThSort field="metric_cadence" filters={filters} onSort={setSort} align="right">Cadence</ThSort>
                  <ThSort field="metric_success_rate" filters={filters} onSort={setSort} align="right">Success</ThSort>
                  <ThSort field="metric_diversity" filters={filters} onSort={setSort} align="right">Diversity</ThSort>
                  <ThSort field="tx_count" filters={filters} onSort={setSort} align="right">Txs</ThSort>
                  <ThSort field="last_seen" filters={filters} onSort={setSort} align="right">Active</ThSort>
                </tr>
              </thead>
              <tbody>
                {entries.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={11} className="text-center py-14 text-[13px] text-[#62666d]">
                      {error ? (
                        <>Failed to load — <span className="text-[#e5484d]">{error}</span></>
                      ) : (
                        <>No agents match these filters.{activeCount > 0 && <> <button onClick={resetAll} className="underline text-[#8a8f98] hover:text-[#f7f8f8]">Clear</button>.</>}</>
                      )}
                    </td>
                  </tr>
                ) : entries.map((e) => <AgentRow key={`${e.chain}:${e.address}:${e.agentId ?? ''}`} entry={e} />)}
                {loading && entries.length === 0 && (
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={`sk-${i}`} className="border-b border-[rgb(255_255_255/0.03)] last:border-0">
                      <td colSpan={11} className="px-3 py-3.5">
                        <div className="h-2.5 rounded-full bg-[rgb(255_255_255/0.04)] animate-pulse" style={{ width: `${92 - i * 6}%` }} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {total != null && entries.length < total && (
          <div className="flex justify-center pt-1">
            <button
              onClick={loadMore}
              disabled={loading}
              className="text-[12px] font-[510] text-[#8a8f98] hover:text-[#f7f8f8] transition-colors disabled:opacity-50"
            >
              {loading ? 'Loading…' : `Load ${Math.min(filters.pageSize, total - entries.length)} more →`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Page-size selector ─────────────────────────────────────────────────────

function PageSizeSelector({
  value,
  onChange,
}: {
  value: PageSize;
  onChange: (n: PageSize) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-[0.08em] text-[#4f5258]">Per page</span>
      <div className="flex items-center rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.02)] p-0.5">
        {PAGE_SIZE_OPTIONS.map((n) => {
          const active = n === value;
          return (
            <button
              key={n}
              type="button"
              onClick={() => onChange(n)}
              aria-pressed={active}
              className={
                active
                  ? 'rounded-[4px] bg-[rgb(255_255_255/0.06)] px-2 py-0.5 text-[11px] font-[590] tabular-nums text-[#f7f8f8]'
                  : 'rounded-[4px] px-2 py-0.5 text-[11px] font-[510] tabular-nums text-[#8a8f98] transition-colors hover:text-[#f7f8f8]'
              }
            >
              {n}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Filter panel ────────────────────────────────────────────────────────────

function FilterPanel({
  filters,
  onToggleTier,
  onToggleConfidence,
  onToggleAutonomy,
  onClaimed,
  onThreshold,
  onReset,
  activeCount,
}: {
  filters: ReturnType<typeof useFilters>;
  onToggleTier: (t: TrustTier) => void;
  onToggleConfidence: (b: ConfidenceBadge) => void;
  onToggleAutonomy: (a: AutonomyLabel) => void;
  onClaimed: (v: boolean | null) => void;
  onThreshold: (key: string, v: number | null) => void;
  onReset: () => void;
  activeCount: number;
}) {
  return (
    <div className="divide-y divide-[rgb(255_255_255/0.05)]">
      <div className="flex items-center justify-between pb-3">
        <div className="inline-flex items-center gap-1.5 text-[10px] font-[590] uppercase tracking-[0.1em] text-[#8a8f98]">
          <SlidersHorizontal className="size-3 opacity-60" />
          Filters
          {activeCount > 0 && (
            <span className="text-[10px] font-[510] tabular-nums text-[#a8b0ff] normal-case tracking-normal">{activeCount}</span>
          )}
        </div>
        {activeCount > 0 && (
          <button
            onClick={onReset}
            className="text-[11px] font-[510] text-[#62666d] hover:text-[#f7f8f8] transition-colors"
          >
            Reset
          </button>
        )}
      </div>

      <FilterSection label="Tier">
        {TIER_OPTIONS.map((t) => (
          <Chip key={t} active={filters.tiers.includes(t)} onClick={() => onToggleTier(t)}>{t}</Chip>
        ))}
      </FilterSection>

      <FilterSection label="Confidence">
        {BADGE_OPTIONS.map((b) => (
          <Chip key={b} active={filters.confidenceBadges.includes(b)} onClick={() => onToggleConfidence(b)}>
            {BADGE_LABEL[b]}
          </Chip>
        ))}
      </FilterSection>

      <FilterSection label="Autonomy">
        {AUTONOMY_OPTIONS.map((a) => (
          <Chip key={a} active={filters.autonomyLabels.includes(a)} onClick={() => onToggleAutonomy(a)}>
            {a}
          </Chip>
        ))}
      </FilterSection>

      <FilterSection label="Identity">
        <Chip active={filters.claimed === true} onClick={() => onClaimed(filters.claimed === true ? null : true)}>Claimed</Chip>
        <Chip active={filters.claimed === false} onClick={() => onClaimed(filters.claimed === false ? null : false)}>Unclaimed</Chip>
      </FilterSection>

      <FilterSection label="Min thresholds" stack>
        <Slider label="Karma"         value={filters.minScore}       min={0} max={100} step={5}    format={(v) => `${v}`} onChange={(v) => onThreshold('minScore',     v)} />
        <Slider label="Cadence"       value={filters.minCadence}     min={0} max={1}   step={0.05} format={pct}           onChange={(v) => onThreshold('minCadence',   v)} />
        <Slider label="Success rate"  value={filters.minSuccessRate} min={0} max={1}   step={0.05} format={pct}           onChange={(v) => onThreshold('minSuccess',   v)} />
        <Slider label="Diversity"     value={filters.minDiversity}   min={0} max={1}   step={0.05} format={pct}           onChange={(v) => onThreshold('minDiversity', v)} />
      </FilterSection>
    </div>
  );
}

// Surface the filter shape so FilterPanel can type against it without imports.
type Filters = {
  tiers: TrustTier[];
  confidenceBadges: ConfidenceBadge[];
  autonomyLabels: AutonomyLabel[];
  claimed: boolean | null;
  minScore: number | null;
  minCadence: number | null;
  minDiversity: number | null;
  minSuccessRate: number | null;
  search: string;
  sortBy: AgentSortField;
  sortDir: 'asc' | 'desc';
};
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function useFilters(): Filters { throw new Error('type only'); }

function pct(v: number) { return `${Math.round(v * 100)}%`; }

function FilterSection({
  label,
  stack = false,
  children,
}: {
  label: string;
  stack?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="py-3 space-y-1.5">
      <div className="text-[10px] font-[590] uppercase tracking-[0.1em] text-[#62666d]">
        {label}
      </div>
      <div className={cn(
        stack ? "space-y-2" : "flex flex-wrap gap-1",
      )}>
        {children}
      </div>
    </div>
  );
}

function Chip({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center text-[11px] font-[510] px-1.5 py-0.5 rounded transition-colors",
        active
          ? "bg-[#5e6ad2]/14 text-[#a8b0ff] ring-1 ring-inset ring-[#5e6ad2]/30"
          : "text-[#8a8f98] hover:text-[#f7f8f8] hover:bg-[rgb(255_255_255/0.04)]",
      )}
    >
      {children}
    </button>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number | null;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number | null) => void;
}) {
  // Local state renders the thumb instantly so dragging feels native; the
  // commit to the parent (URL + refetch) only fires on release so dragging
  // across the track doesn't spam 50 queries.
  const [local, setLocal] = useState<number | null>(value);
  useEffect(() => { setLocal(value); }, [value]);
  const localRef = useRef(local);
  useEffect(() => { localRef.current = local; }, [local]);
  const commit = useCallback(() => {
    if (localRef.current === value) return;
    onChange(localRef.current);
  }, [value, onChange]);

  const current = local ?? min;
  const active = local != null;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-[#8a8f98]">{label}</span>
        <span className="inline-flex items-center gap-1.5">
          <span className={cn(
            "tabular-nums font-[510] transition-colors",
            active ? "text-[#a8b0ff]" : "text-[#62666d]",
          )}>
            {active ? `≥ ${format(local!)}` : 'any'}
          </span>
          {active && (
            <button
              onClick={() => { setLocal(null); onChange(null); }}
              className="text-[#62666d] hover:text-[#e5484d] transition-colors"
              aria-label={`Clear ${label}`}
            >
              <X className="size-3" />
            </button>
          )}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={current}
        onChange={(e) => {
          const v = Number(e.target.value);
          setLocal(v === min ? null : v);
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="w-full h-1 accent-[#5e6ad2] cursor-pointer"
      />
    </div>
  );
}

// ─── Sort menu ────────────────────────────────────────────────────────────────

function SortMenu({
  open, onOpenChange, sortBy, sortDir, onPick, onToggleDir,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sortBy: AgentSortField;
  sortDir: 'asc' | 'desc';
  onPick: (f: AgentSortField) => void;
  onToggleDir: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOpenChange(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onOpenChange(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={ref} className="relative flex items-center gap-1">
      <button
        onClick={() => onOpenChange(!open)}
        className="h-9 inline-flex items-center gap-1.5 px-3 border border-[rgb(255_255_255/0.08)] rounded-md text-[12px] text-[#d0d6e0] hover:bg-[rgb(255_255_255/0.03)] transition-colors"
      >
        <span className="text-[#62666d]">Sort</span>
        <span className="font-[510]">{SORT_LABELS[sortBy]}</span>
        <ChevronsUpDown className="size-3 text-[#62666d]" />
      </button>
      <button
        onClick={onToggleDir}
        aria-label="Toggle sort direction"
        className="h-9 w-9 inline-flex items-center justify-center border border-[rgb(255_255_255/0.08)] rounded-md text-[#d0d6e0] hover:bg-[rgb(255_255_255/0.03)] transition-colors"
      >
        {sortDir === 'desc' ? <ArrowDown className="size-3.5" /> : <ArrowUp className="size-3.5" />}
      </button>

      {open && (
        <div className="absolute right-0 top-[calc(100%+4px)] z-20 min-w-[180px] rounded-md border border-[rgb(255_255_255/0.08)] bg-[#0d0e11] shadow-[0_10px_30px_-12px_rgba(0,0,0,0.6)] overflow-hidden">
          {SORT_FIELDS.map((f) => (
            <button
              key={f}
              onClick={() => onPick(f)}
              className={cn(
                "w-full text-left px-3 py-2 text-[12px] transition-colors",
                sortBy === f
                  ? "text-[#f7f8f8] bg-[#5e6ad2]/10"
                  : "text-[#9aa0a8] hover:text-[#f7f8f8] hover:bg-[rgb(255_255_255/0.04)]",
              )}
            >
              {SORT_LABELS[f]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Table pieces ─────────────────────────────────────────────────────────────

function Th({
  children,
  align = 'left',
  className,
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <th className={cn(
      "px-3 py-2.5 text-[10px] font-[590] uppercase tracking-[0.08em] text-[#62666d]",
      align === 'right' ? 'text-right' : 'text-left',
      className,
    )}>
      {children}
    </th>
  );
}

function ThSort({
  field, filters, onSort, align = 'left', className, title, children,
}: {
  field: AgentSortField;
  filters: { sortBy: AgentSortField; sortDir: 'asc' | 'desc' };
  onSort: (f: AgentSortField) => void;
  align?: 'left' | 'right';
  className?: string;
  title?: string;
  children: React.ReactNode;
}) {
  const active = filters.sortBy === field;
  const Icon = !active ? ChevronsUpDown : filters.sortDir === 'desc' ? ArrowDown : ArrowUp;
  return (
    <th
      onClick={() => onSort(field)}
      title={title}
      className={cn(
        "group px-3 py-2.5 text-[10px] font-[590] uppercase tracking-[0.08em] cursor-pointer select-none transition-colors",
        active ? "text-[#f7f8f8]" : "text-[#62666d] hover:text-[#d0d6e0]",
        align === 'right' ? 'text-right' : 'text-left',
        className,
      )}
    >
      <span className={cn("inline-flex items-center gap-1.5", align === 'right' && 'justify-end w-full')}>
        {children}
        <Icon className={cn(
          "size-3 transition-opacity",
          active ? "opacity-100" : "opacity-0 group-hover:opacity-60",
        )} />
      </span>
    </th>
  );
}

function AgentRow({ entry }: { entry: ApiEntry }) {
  const href = agentHref(entry);
  return (
    <tr
      className="group border-b border-[rgb(255_255_255/0.04)] last:border-0 hover:bg-[rgb(255_255_255/0.025)] transition-colors cursor-pointer"
      onClick={() => (window.location.href = href)}
    >
      <td className="px-3 py-3 tabular-nums text-[#62666d] text-[11px]">{entry.rank}</td>
      <td className="px-3 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <AgentAvatar
            src={entry.imageUrl}
            name={entry.displayName ?? entry.address}
            size={22}
            className="rounded-md"
          />
          <ChainBadge chain={entry.chain} />
          {entry.displayName ? (
            <Link
              href={href}
              onClick={(e) => e.stopPropagation()}
              className="font-[510] text-[#f7f8f8] hover:text-[#a8b0ff] transition-colors min-w-0 truncate"
            >
              {entry.displayName}
            </Link>
          ) : (
            <WalletAddress
              address={entry.address}
              href={href}
              truncate={true}
              className="text-[#d0d6e0]"
            />
          )}
          {entry.claimed && <Verified className="size-3 shrink-0 text-[#828fff]" aria-label="Claimed" />}
        </div>
      </td>
      <td className="px-3 py-3 text-right tabular-nums font-[510] text-[#f7f8f8]">
        {entry.providerScore.toFixed(1)}
      </td>
      <td className="px-3 py-3"><TierBadge tier={entry.trustTier} size="sm" /></td>
      <td className="px-3 py-3"><ConfidenceBadgeChip badge={entry.confidenceBadge} size="sm" /></td>
      <td className="px-3 py-3">
        {entry.autonomyScore != null && entry.autonomyLabel ? (
          <AutonomyChip score={entry.autonomyScore} label={entry.autonomyLabel} size="sm" />
        ) : <Muted />}
      </td>
      <MetricCell value={entry.metrics.cadence} />
      <MetricCell value={entry.metrics.successRate} />
      <MetricCell value={entry.metrics.diversity} />
      <td className="px-3 py-3 text-right tabular-nums text-[#d0d6e0]">
        {entry.txCount.toLocaleString()}
      </td>
      <td className="px-3 py-3 text-right">
        <LivenessIndicator lastSeen={entry.lastSeen} size="sm" />
      </td>
    </tr>
  );
}

function Muted() {
  return <span className="text-[#4b4e54]">—</span>;
}

function MetricCell({ value }: { value: number | null }) {
  if (value == null) {
    return <td className="px-3 py-3 text-right"><Muted /></td>;
  }
  const pct = Math.round(value * 100);
  return (
    <td className="px-3 py-3 text-right tabular-nums text-[#d0d6e0]">
      {pct}<span className="text-[#62666d]">%</span>
    </td>
  );
}
