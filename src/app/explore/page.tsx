import Link from 'next/link';
import { getFacilitatorStats, getRecentTransactions } from '@/db/client';
import { SOLANA_FACILITATORS, getFacilitatorName } from '@/config/facilitators';
import { WalletAddress } from '@/components/karma/wallet-address';
import { Badge } from '@/components/ui/badge';

interface Props {
  searchParams: Promise<{ f?: string }>;
}

export default async function ExplorePage({ searchParams }: Props) {
  const { f: selectedFacilitator } = await searchParams;

  let facilitatorStats: Awaited<ReturnType<typeof getFacilitatorStats>> = [];
  let recentTxs: Awaited<ReturnType<typeof getRecentTransactions>> = [];
  let dbError = false;

  try {
    [facilitatorStats, recentTxs] = await Promise.all([
      getFacilitatorStats(),
      getRecentTransactions(selectedFacilitator, 40),
    ]);
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
          />
          <RecentActivity
            transactions={recentTxs}
            selectedFacilitator={selectedFacilitator}
          />
        </div>
      )}
    </div>
  );
}

function FacilitatorSidebar({
  facilitators,
  statsMap,
  selected,
}: {
  facilitators: [string, string[]][];
  statsMap: Map<string, { txCount: number; uniqueAgents: number; totalVolume: number }>;
  selected?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-[510] text-[#62666d] tracking-[-0.13px]">
          Facilitators
        </h2>
        {selected && (
          <Link
            href="/explore"
            className="text-[12px] font-[510] text-[#5e6ad2] hover:text-[#828fff] transition-colors"
          >
            Clear filter
          </Link>
        )}
      </div>

      <Link
        href="/explore"
        className={`flex items-center justify-between rounded-md px-3 py-2 text-[13px] font-[510] transition-colors ${
          !selected
            ? 'bg-[rgb(255_255_255/0.05)] text-[#f7f8f8] border border-[rgb(255_255_255/0.08)]'
            : 'text-[#8a8f98] hover:bg-[rgb(255_255_255/0.03)] hover:text-[#d0d6e0]'
        }`}
      >
        <span>All facilitators</span>
        <span className="text-[11px] tabular-nums text-[#62666d]">
          {Array.from(statsMap.values()).reduce((s, v) => s + v.txCount, 0)}
        </span>
      </Link>

      {facilitators.map(([name, addresses]) => {
        const firstAddr = addresses[0];
        const combined = addresses.reduce(
          (acc, addr) => {
            const s = statsMap.get(addr);
            if (s) {
              acc.txCount += s.txCount;
              acc.uniqueAgents += s.uniqueAgents;
            }
            return acc;
          },
          { txCount: 0, uniqueAgents: 0 },
        );
        const isSelected = selected && addresses.includes(selected);

        return (
          <Link
            key={name}
            href={`/explore?f=${firstAddr}`}
            className={`flex items-center justify-between rounded-md px-3 py-2 transition-colors ${
              isSelected
                ? 'bg-[rgb(255_255_255/0.05)] text-[#f7f8f8] border border-[rgb(255_255_255/0.08)]'
                : 'text-[#8a8f98] hover:bg-[rgb(255_255_255/0.03)] hover:text-[#d0d6e0]'
            }`}
          >
            <div className="flex items-center gap-2">
              <div className={`size-1.5 rounded-full ${isSelected ? 'bg-[#7170ff]' : 'bg-[#5e6ad2]'}`} />
              <span className="text-[13px] font-[510] capitalize">{name}</span>
            </div>
            {combined.txCount > 0 && (
              <span className="text-[11px] tabular-nums text-[#62666d]">
                {combined.txCount}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}

function RecentActivity({
  transactions,
  selectedFacilitator,
}: {
  transactions: Awaited<ReturnType<typeof getRecentTransactions>>;
  selectedFacilitator?: string;
}) {
  const facilitatorLabel = selectedFacilitator
    ? getFacilitatorName(selectedFacilitator) ?? selectedFacilitator.slice(0, 8)
    : null;

  return (
    <div className="rounded-lg border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
      <div className="border-b border-[rgb(255_255_255/0.05)] px-4 py-3 flex items-center gap-2">
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

      {transactions.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-[14px] text-[#8a8f98]">No transactions recorded yet.</p>
          <p className="mt-1 text-[12px] text-[#62666d]">
            Run the indexer to start tracking x402 payments.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-[rgb(255_255_255/0.05)]">
          {transactions.map((tx) => (
            <div
              key={tx.id}
              className="flex items-center justify-between gap-4 px-4 py-2.5 hover:bg-[rgb(255_255_255/0.02)] transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className={`size-1.5 shrink-0 rounded-full ${tx.success ? 'bg-[#10b981]' : 'bg-[#e5484d]'}`} />
                <Link
                  href={`/agent/${tx.wallet_address}`}
                  className="hover:underline underline-offset-4"
                >
                  <WalletAddress address={tx.wallet_address} copyable={false} className="text-[#d0d6e0]" />
                </Link>
                {!selectedFacilitator && (
                  <span className="hidden sm:inline text-[11px] font-[510] capitalize text-[#62666d]">
                    via {getFacilitatorName(tx.facilitator) ?? tx.facilitator.slice(0, 6)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-4 shrink-0">
                <span className="text-[13px] font-[510] tabular-nums text-[#d0d6e0]">
                  ${Number(tx.amount).toFixed(2)}
                </span>
                <span className="hidden sm:inline text-[12px] tabular-nums text-[#62666d]">
                  {new Date(tx.timestamp).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>
                <span className="font-mono text-[11px] text-[#62666d]">
                  {tx.tx_signature.slice(0, 8)}..
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
