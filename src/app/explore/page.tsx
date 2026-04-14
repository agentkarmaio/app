import Link from 'next/link';
import {
  getFacilitatorStats,
  getRecentTransactions,
  getWalletTiers,
} from '@/db/client';
import { SOLANA_FACILITATORS, getFacilitatorName } from '@/config/facilitators';
import { WalletAddress } from '@/components/karma/wallet-address';
import { TierBadge } from '@/components/karma/tier-badge';
import { Badge } from '@/components/ui/badge';
import type { TrustTier } from '@/db/schema';

export const dynamic = 'force-dynamic';

type TimeWindow = '1d' | '7d' | '30d' | 'all';

const TIME_WINDOWS: { key: TimeWindow; label: string; days: number | null }[] = [
  { key: '1d', label: '1D', days: 1 },
  { key: '7d', label: '7D', days: 7 },
  { key: '30d', label: '30D', days: 30 },
  { key: 'all', label: 'All', days: null },
];

interface Props {
  searchParams: Promise<{ f?: string; t?: TimeWindow }>;
}

export default async function ExplorePage({ searchParams }: Props) {
  const { f: selectedFacilitator, t: timeParam } = await searchParams;
  const timeWindow: TimeWindow = (timeParam && TIME_WINDOWS.find((w) => w.key === timeParam))
    ? timeParam
    : 'all';
  const daysBack = TIME_WINDOWS.find((w) => w.key === timeWindow)?.days ?? null;
  const since = daysBack != null ? new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000) : undefined;

  let facilitatorStats: Awaited<ReturnType<typeof getFacilitatorStats>> = [];
  let recentTxs: Awaited<ReturnType<typeof getRecentTransactions>> = [];
  let tierMap: Map<string, TrustTier> = new Map();
  let dbError = false;

  try {
    [facilitatorStats, recentTxs] = await Promise.all([
      getFacilitatorStats(),
      getRecentTransactions(selectedFacilitator, 40, since),
    ]);
    const uniqueSenders = [...new Set(recentTxs.map((t) => t.wallet_address))];
    tierMap = await getWalletTiers(uniqueSenders);
  } catch {
    dbError = true;
  }

  const allFacilitators = Object.entries(SOLANA_FACILITATORS);
  const statsMap = new Map(facilitatorStats.map((s) => [s.facilitator, s]));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-[32px] font-[510] leading-tight tracking-[-0.704px] text-[#f7f8f8]">
          Explore
        </h1>
        <p className="mt-1.5 text-[15px] text-[#8a8f98] tracking-[-0.165px]">
          Browse x402 facilitators and recent agent payments on Solana.
        </p>
      </div>

      {dbError ? (
        <div className="rounded-lg border border-dashed border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] p-12 text-center">
          <p className="text-[#8a8f98] text-[15px]">Database not connected.</p>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
          <FacilitatorSidebar
            facilitators={allFacilitators}
            statsMap={statsMap}
            selected={selectedFacilitator}
            timeWindow={timeWindow}
          />
          <RecentActivity
            transactions={recentTxs}
            tierMap={tierMap}
            selectedFacilitator={selectedFacilitator}
            timeWindow={timeWindow}
          />
        </div>
      )}
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
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-[510] text-[#62666d] tracking-[-0.13px]">
          Facilitators
        </h2>
        {selected && (
          <Link
            href={buildHref(undefined, timeWindow)}
            className="text-[12px] font-[510] text-[#5e6ad2] hover:text-[#828fff] transition-colors"
          >
            Clear filter
          </Link>
        )}
      </div>

      <Link
        href={buildHref(undefined, timeWindow)}
        className={`flex items-center justify-between rounded-md px-3 py-2 text-[13px] font-[510] transition-colors ${
          !selected
            ? 'bg-[rgb(255_255_255/0.05)] text-[#f7f8f8] border border-[rgb(255_255_255/0.08)]'
            : 'text-[#8a8f98] hover:bg-[rgb(255_255_255/0.03)] hover:text-[#d0d6e0]'
        }`}
      >
        <span>All facilitators</span>
        <span className="text-[11px] tabular-nums text-[#62666d]">{totalTxCount}</span>
      </Link>

      {combined.map((c) => {
        const isSelected = selected && c.addresses.includes(selected);
        const widthPct = c.totalVolume > 0 ? (c.totalVolume / maxVolume) * 100 : 0;

        return (
          <Link
            key={c.name}
            href={buildHref(c.firstAddr, timeWindow)}
            className={`relative flex items-center justify-between overflow-hidden rounded-md px-3 py-2 transition-colors ${
              isSelected
                ? 'bg-[rgb(255_255_255/0.05)] text-[#f7f8f8] border border-[rgb(255_255_255/0.08)]'
                : 'text-[#8a8f98] hover:bg-[rgb(255_255_255/0.03)] hover:text-[#d0d6e0]'
            }`}
          >
            {widthPct > 0 && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 left-0 bg-[rgb(94_106_210/0.10)]"
                style={{ width: `${widthPct}%` }}
              />
            )}
            <div className="relative flex items-center gap-2">
              <div className={`size-1.5 rounded-full ${isSelected ? 'bg-[#7170ff]' : 'bg-[#5e6ad2]'}`} />
              <span className="text-[13px] font-[510] capitalize">{c.name}</span>
            </div>
            {c.txCount > 0 && (
              <span className="relative text-[11px] tabular-nums text-[#62666d]">
                {c.txCount}
              </span>
            )}
          </Link>
        );
      })}
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
    <div className="flex items-center gap-1 rounded-md border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] p-0.5">
      {TIME_WINDOWS.map((w) => (
        <Link
          key={w.key}
          href={buildHref(selectedFacilitator, w.key)}
          className={`rounded px-2 py-0.5 text-[11px] font-[510] tabular-nums transition-colors ${
            timeWindow === w.key
              ? 'bg-[rgb(255_255_255/0.06)] text-[#f7f8f8]'
              : 'text-[#62666d] hover:text-[#d0d6e0]'
          }`}
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
    <div className="rounded-lg border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
      <div className="border-b border-[rgb(255_255_255/0.05)] px-4 py-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-[13px] font-[510] text-[#62666d] tracking-[-0.13px]">
            Recent Payments
          </h2>
          {facilitatorLabel && (
            <Badge
              variant="outline"
              className="bg-[rgb(94_106_210/0.12)] text-[#828fff] border-[rgb(94_106_210/0.2)] text-[10px] font-[510] capitalize"
            >
              {facilitatorLabel}
            </Badge>
          )}
        </div>
        <TimeFilterChips selectedFacilitator={selectedFacilitator} timeWindow={timeWindow} />
      </div>

      {transactions.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-[14px] text-[#8a8f98]">No transactions in this window.</p>
          <p className="mt-1 text-[12px] text-[#62666d]">
            Try widening the time filter or clearing the facilitator filter.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-[rgb(255_255_255/0.05)]">
          {transactions.map((tx) => {
            const tier = tierMap.get(tx.wallet_address);
            return (
              <div
                key={tx.id}
                className="flex items-center justify-between gap-4 px-4 py-2.5 hover:bg-[rgb(255_255_255/0.02)] transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`size-1.5 shrink-0 rounded-full ${tx.success ? 'bg-[#10b981]' : 'bg-[#e5484d]'}`} />
                  <Link
                    href={`/agent/${tx.wallet_address}`}
                    className="flex items-center gap-2 hover:underline underline-offset-4"
                  >
                    <WalletAddress address={tx.wallet_address} copyable={false} className="text-[#d0d6e0]" />
                    {tier && tier !== 'Unrated' && <TierBadge tier={tier} size="sm" />}
                  </Link>
                  {!selectedFacilitator && (
                    <span className="hidden sm:inline text-[11px] font-[510] capitalize text-[#62666d]">
                      via {getFacilitatorName(tx.facilitator) ?? tx.facilitator.slice(0, 6)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <span className="text-[13px] font-[510] tabular-nums text-[#d0d6e0]">
                    {Number(tx.amount).toFixed(2)} <span className="text-[#62666d] text-[11px]">USDC</span>
                  </span>
                  <span className="hidden sm:inline text-[12px] tabular-nums text-[#62666d]">
                    {new Date(tx.timestamp).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                  <a
                    href={`https://solscan.io/tx/${tx.tx_signature}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[11px] text-[#62666d] hover:text-[#8a8f98] transition-colors"
                  >
                    {tx.tx_signature.slice(0, 8)}..
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
