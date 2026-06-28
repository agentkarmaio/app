import Link from 'next/link';
import { Suspense } from 'react';
import type { Metadata } from 'next';
import {
  cachedFacilitatorStats,
  cachedRecentTransactions,
  cachedStats,
  getCachedWalletTierMap,
} from '@/db/cached';
import type { getFacilitatorStats, getRecentTransactions } from '@/db/client';
import { SOLANA_FACILITATORS, getFacilitatorName } from '@/config/facilitators';
import { WalletAddress } from '@/components/karma/wallet-address';
import { TierBadge } from '@/components/karma/tier-badge';
import { KarmaCatchingUp } from '@/components/karma/karma-catching-up';
import { AgentsExplorer } from '@/components/karma/agents-explorer';
import { cn } from '@/lib/utils';
import type { TrustTier } from '@/db/schema';
import { formatUsdcAmount } from '@/lib/format';

// Dynamic so the headline agent count tracks the live canonical population
// (the same `explore_agents` total the page and homepage counter read) instead
// of a hardcoded figure that silently goes stale. Floored to a round "+" so the
// SEO copy stays stable between crawls while never overstating the count.
export async function generateMetadata(): Promise<Metadata> {
  const stats = await cachedStats().catch(() => null);
  const n = stats?.totalAgents ?? 0;
  const agentCount = n >= 1000 ? `${Math.floor(n / 1000).toLocaleString()},000+` : '100,000+';
  return {
    title: 'Explore — Agents + Activity',
    description:
      `Browse ${agentCount} autonomous on-chain agents across Solana, Celo, Stellar, and Arc ranked by Provider Karma, filter by tier, confidence badge, and autonomy. Live x402 + pay.sh activity feed.`,
    alternates: { canonical: '/explore' },
    openGraph: {
      title: 'Explore agents — AgentKarma',
      description:
        'Live directory of autonomous on-chain agents, ranked by reputation across Solana, Celo, Stellar, and Arc.',
      url: 'https://agentkarma.io/explore',
    },
  };
}

type ExploreTab = 'agents' | 'activity';
type TimeWindow = '1d' | '7d' | '30d' | 'all';

const TIME_WINDOWS: { key: TimeWindow; label: string; days: number | null }[] = [
  { key: '1d', label: '1D', days: 1 },
  { key: '7d', label: '7D', days: 7 },
  { key: '30d', label: '30D', days: 30 },
  { key: 'all', label: 'All', days: null },
];

interface Props {
  searchParams: Promise<Record<string, string | undefined>>;
}

export default async function ExplorePage({ searchParams }: Props) {
  const params = await searchParams;
  const tab: ExploreTab = params.tab === 'activity' ? 'activity' : 'agents';
  const selectedFacilitator = params.f;
  const timeWindow: TimeWindow = (params.t && TIME_WINDOWS.find((w) => w.key === params.t))
    ? params.t as TimeWindow
    : 'all';
  const daysBack = TIME_WINDOWS.find((w) => w.key === timeWindow)?.days ?? null;
  const sinceIso = daysBack != null
    ? new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString()
    : undefined;

  // Breakout: the root <main> clamps to max-w-5xl with px-4. This page wants
  // the full viewport so the left filter rail can sit near the edge and the
  // 11-column table can stretch. No horizontal padding on the outer — each
  // child section re-applies its own, asymmetric for the agents layout so the
  // filter rail pulls all the way left with just enough inset to breathe.
  return (
    <div className="relative md:left-1/2 md:right-1/2 md:-ml-[50vw] md:-mr-[50vw] md:w-screen space-y-6">
      <div className="px-4 md:px-6 xl:px-8 max-w-5xl">
        <h1 className="text-[30px] font-[510] leading-tight tracking-[-0.704px] text-[#f7f8f8]">
          Explore
        </h1>
        <p className="mt-1 text-[14px] text-[#8a8f98] tracking-[-0.165px]">
          {tab === 'agents'
            ? 'Filter and sort every scored agent by behavior, autonomy, and receipts.'
            : 'Browse x402 facilitators and recent agent payments on Solana.'}
        </p>
      </div>

      <div className="px-4 md:px-6 xl:px-8">
        <TabNav active={tab} />
      </div>

      {tab === 'agents' ? (
        <div className="pl-3 md:pl-4 pr-4 md:pr-8 xl:pr-10">
          <AgentsExplorer />
        </div>
      ) : (
        <div className="pl-3 md:pl-4 pr-4 md:pr-8 xl:pr-10">
          <Suspense
            fallback={<ActivityTabSkeleton />}
            key={`${selectedFacilitator ?? ''}-${timeWindow}`}
          >
            <ActivityTabAsync
              selectedFacilitator={selectedFacilitator}
              timeWindow={timeWindow}
              sinceIso={sinceIso}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}

function TabNav({ active }: { active: ExploreTab }) {
  // Agents + Activity are tabs of this page; Estates + Sureties are full
  // dashboards (the Dead Man's Switch + Lloyd's surfaces) that live at their own
  // routes — link out so the nav stays one coherent directory entry point.
  const tabs: { href: string; label: string; active: boolean; pill?: string }[] = [
    { href: '/explore?tab=agents', label: 'Agents', active: active === 'agents' },
    { href: '/explore?tab=activity', label: 'Activity', active: active === 'activity' },
    { href: '/estates', label: 'Estates', active: false },
    { href: '/sureties', label: 'Sureties', active: false, pill: 'planned' },
  ];
  return (
    <div className="border-b border-[rgb(255_255_255/0.06)] flex gap-5">
      {tabs.map((t) => (
        <Link
          key={t.label}
          href={t.href}
          className={cn(
            "pb-2.5 -mb-px border-b-2 text-[13px] font-[510] tracking-[-0.165px] transition-colors inline-flex items-center gap-1.5",
            t.active
              ? "border-[#5e6ad2] text-[#f7f8f8]"
              : "border-transparent text-[#8a8f98] hover:text-[#f7f8f8]",
          )}
        >
          {t.label}
          {t.pill && (
            <span className="rounded-full border border-[rgb(245_166_35/0.22)] bg-[rgb(245_166_35/0.10)] px-1.5 py-0 text-[9px] font-[510] uppercase tracking-[0.08em] text-[#f5a623]">
              {t.pill}
            </span>
          )}
        </Link>
      ))}
    </div>
  );
}

async function ActivityTabAsync({
  selectedFacilitator,
  timeWindow,
  sinceIso,
}: {
  selectedFacilitator?: string;
  timeWindow: TimeWindow;
  sinceIso?: string;
}) {
  const allFacilitators = Object.entries(SOLANA_FACILITATORS);
  let stats: Awaited<ReturnType<typeof getFacilitatorStats>> = [];
  let recentTxs: Awaited<ReturnType<typeof getRecentTransactions>> = [];
  let tierMap: Map<string, TrustTier> = new Map();
  let dbError = false;

  try {
    // Facilitator stats and recent txs are independent — fetch concurrently
    // so the streamed boundary stays open for max(stats, txs) rather than
    // their sum. Wallet tiers depend on the senders the tx query returns, so
    // that one trails. One try/catch → one coherent fallback for the tab.
    [stats, recentTxs] = await Promise.all([
      cachedFacilitatorStats(),
      cachedRecentTransactions(selectedFacilitator, sinceIso),
    ]);
    const uniqueSenders = [...new Set(recentTxs.map((t) => t.wallet_address))];
    tierMap = await getCachedWalletTierMap(uniqueSenders);
  } catch {
    dbError = true;
  }

  const statsMap = new Map(stats.map((s) => [s.facilitator, s]));

  return (
    <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
      <FacilitatorSidebar
        facilitators={allFacilitators}
        statsMap={statsMap}
        selected={selectedFacilitator}
        timeWindow={timeWindow}
      />
      {dbError ? (
        <KarmaCatchingUp />
      ) : (
        <RecentActivity
          transactions={recentTxs}
          tierMap={tierMap}
          selectedFacilitator={selectedFacilitator}
          timeWindow={timeWindow}
        />
      )}
    </div>
  );
}

function SidebarSkeleton() {
  return (
    <div className="space-y-1.5 pt-1">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="h-6 w-full animate-pulse rounded bg-[rgb(255_255_255/0.03)]" style={{ width: `${85 - i * 4}%` }} />
      ))}
    </div>
  );
}

function ActivitySkeleton() {
  return (
    <div className="rounded-lg border border-[rgb(255_255_255/0.06)] overflow-hidden">
      <div className="bg-[rgb(255_255_255/0.015)] border-b border-[rgb(255_255_255/0.06)] px-4 py-2.5">
        <div className="h-3 w-32 animate-pulse rounded bg-[rgb(255_255_255/0.04)]" />
      </div>
      <div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="border-b border-[rgb(255_255_255/0.04)] last:border-0 flex items-center justify-between gap-4 px-4 py-3">
            <div className="h-2.5 w-48 animate-pulse rounded-full bg-[rgb(255_255_255/0.04)]" />
            <div className="h-2.5 w-24 animate-pulse rounded-full bg-[rgb(255_255_255/0.04)]" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ActivityTabSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
      <SidebarSkeleton />
      <ActivitySkeleton />
    </div>
  );
}

function buildHref(f?: string, t?: TimeWindow): string {
  const params = new URLSearchParams();
  if (f) params.set('f', f);
  if (t && t !== 'all') params.set('t', t);
  const qs = params.toString();
  return qs ? `/explore?${qs}` : '/explore';
}

function FacilitatorSidebar({
  facilitators,
  statsMap,
  selected,
  timeWindow,
}: {
  facilitators: [string, string[]][];
  statsMap: Map<string, { txCount: number; uniqueAgents: number; totalVolume: number }>;
  selected?: string;
  timeWindow: TimeWindow;
}) {
  // Compute combined per-facilitator stats + find max volume for bar scaling
  const combined = facilitators.map(([name, addresses]) => {
    const firstAddr = addresses[0];
    const agg = addresses.reduce(
      (acc, addr) => {
        const s = statsMap.get(addr);
        if (s) {
          acc.txCount += s.txCount;
          acc.uniqueAgents += s.uniqueAgents;
          acc.totalVolume += s.totalVolume;
        }
        return acc;
      },
      { txCount: 0, uniqueAgents: 0, totalVolume: 0 },
    );
    return { name, firstAddr, addresses, ...agg };
  });

  const maxVolume = Math.max(0.0001, ...combined.map((c) => c.totalVolume));
  const totalTxCount = combined.reduce((s, c) => s + c.txCount, 0);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-[590] uppercase tracking-[0.1em] text-[#62666d]">
          Facilitators
        </span>
        {selected && (
          <Link
            href={buildHref(undefined, timeWindow)}
            className="text-[11px] font-[510] text-[#62666d] hover:text-[#f7f8f8] transition-colors"
          >
            Clear
          </Link>
        )}
      </div>

      <div className="space-y-px">
        <Link
          href={buildHref(undefined, timeWindow)}
          className={cn(
            "group/row relative flex items-center justify-between px-2 py-1 rounded transition-colors",
            !selected
              ? "bg-[#5e6ad2]/12 text-[#f7f8f8]"
              : "text-[#9aa0a8] hover:text-[#f7f8f8] hover:bg-[rgb(255_255_255/0.04)]",
          )}
        >
          <span className="text-[12px] font-[510]">All facilitators</span>
          <span className="text-[11px] tabular-nums text-[#62666d] group-hover/row:text-[#8a8f98]">
            {totalTxCount.toLocaleString()}
          </span>
        </Link>

        {combined.map((c) => {
          const isSelected = selected && c.addresses.includes(selected);
          const widthPct = c.totalVolume > 0 ? (c.totalVolume / maxVolume) * 100 : 0;

          return (
            <Link
              key={c.name}
              href={buildHref(c.firstAddr, timeWindow)}
              className={cn(
                "group/row relative flex items-center justify-between overflow-hidden px-2 py-1 rounded transition-colors",
                isSelected
                  ? "bg-[#5e6ad2]/12 text-[#f7f8f8]"
                  : "text-[#9aa0a8] hover:text-[#f7f8f8] hover:bg-[rgb(255_255_255/0.04)]",
              )}
            >
              {widthPct > 0 && (
                <div
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute inset-y-0 left-0",
                    isSelected ? "bg-[#5e6ad2]/[0.05]" : "bg-[rgb(255_255_255/0.02)]",
                  )}
                  style={{ width: `${widthPct}%` }}
                />
              )}
              <span className="relative text-[12px] font-[510] capitalize truncate">
                {c.name}
              </span>
              {c.txCount > 0 && (
                <span className="relative text-[11px] tabular-nums text-[#62666d] group-hover/row:text-[#8a8f98] shrink-0 ml-2">
                  {c.txCount.toLocaleString()}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function TimeFilterChips({
  selectedFacilitator,
  timeWindow,
}: {
  selectedFacilitator?: string;
  timeWindow: TimeWindow;
}) {
  return (
    <div className="flex items-center gap-0.5">
      {TIME_WINDOWS.map((w) => (
        <Link
          key={w.key}
          href={buildHref(selectedFacilitator, w.key)}
          className={cn(
            "px-1.5 py-0.5 rounded text-[11px] font-[510] tabular-nums transition-colors",
            timeWindow === w.key
              ? "bg-[#5e6ad2]/14 text-[#a8b0ff] ring-1 ring-inset ring-[#5e6ad2]/30"
              : "text-[#8a8f98] hover:text-[#f7f8f8] hover:bg-[rgb(255_255_255/0.04)]",
          )}
        >
          {w.label}
        </Link>
      ))}
    </div>
  );
}

function RecentActivity({
  transactions,
  tierMap,
  selectedFacilitator,
  timeWindow,
}: {
  transactions: Awaited<ReturnType<typeof getRecentTransactions>>;
  tierMap: Map<string, TrustTier>;
  selectedFacilitator?: string;
  timeWindow: TimeWindow;
}) {
  const facilitatorLabel = selectedFacilitator
    ? getFacilitatorName(selectedFacilitator) ?? selectedFacilitator.slice(0, 8)
    : null;

  return (
    <div className="rounded-lg border border-[rgb(255_255_255/0.06)] overflow-hidden">
      <div className="bg-[rgb(255_255_255/0.015)] border-b border-[rgb(255_255_255/0.06)] px-4 py-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-[590] uppercase tracking-[0.08em] text-[#62666d]">
            Recent Payments
          </span>
          {facilitatorLabel && (
            <span className="text-[10px] font-[510] capitalize px-1.5 py-0.5 rounded text-[#a8b0ff] bg-[#5e6ad2]/14 ring-1 ring-inset ring-[#5e6ad2]/30">
              {facilitatorLabel}
            </span>
          )}
        </div>
        <TimeFilterChips selectedFacilitator={selectedFacilitator} timeWindow={timeWindow} />
      </div>

      {transactions.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-[13px] text-[#8a8f98]">No transactions in this window.</p>
          <p className="mt-1 text-[11px] text-[#62666d]">
            Try widening the time filter or clearing the facilitator filter.
          </p>
        </div>
      ) : (
        <div>
          {transactions.map((tx) => {
            const tier = tierMap.get(tx.wallet_address);
            return (
              <div
                key={tx.id}
                className="group border-b border-[rgb(255_255_255/0.04)] last:border-0 flex items-center justify-between gap-4 px-4 py-2.5 hover:bg-[rgb(255_255_255/0.025)] transition-colors text-[12px]"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div
                    aria-hidden
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      tx.success ? "bg-[#10b981]" : "bg-[#e5484d]",
                    )}
                  />
                  <Link
                    href={`/agent/${tx.wallet_address}`}
                    className="font-mono text-[#d0d6e0] hover:text-[#a8b0ff] transition-colors"
                  >
                    <WalletAddress address={tx.wallet_address} copyable={false} />
                  </Link>
                  {tier && tier !== 'Unrated' && <TierBadge tier={tier} size="sm" />}
                  {!selectedFacilitator && (
                    <span className="hidden sm:inline text-[11px] capitalize text-[#62666d]">
                      via {getFacilitatorName(tx.facilitator) ?? tx.facilitator.slice(0, 6)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <span className="font-[510] tabular-nums text-[#d0d6e0]">
                    {formatUsdcAmount(Number(tx.amount))}
                    <span className="text-[#62666d] text-[10px] ml-1">USDC</span>
                  </span>
                  <span className="hidden sm:inline text-[11px] tabular-nums text-[#62666d] w-12 text-right">
                    {new Date(tx.timestamp).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                  <a
                    href={`https://solscan.io/tx/${tx.tx_signature}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="font-mono text-[10px] text-[#4b4e54] group-hover:text-[#62666d] hover:!text-[#a8b0ff] transition-colors"
                    title={tx.tx_signature}
                  >
                    {tx.tx_signature.slice(0, 6)}…
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
