import { Users, ArrowLeftRight, DollarSign, Shield } from 'lucide-react';

interface StatsData {
  totalAgents: number;
  totalTransactions: number;
  totalVolumeUsdc: number;
  tierDistribution: Record<string, number>;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatUsdc(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

const STAT_ITEMS = [
  {
    key: 'agents' as const,
    label: 'Tracked Agents',
    icon: Users,
    getValue: (d: StatsData) => formatNumber(d.totalAgents),
  },
  {
    key: 'txs' as const,
    label: 'Transactions',
    icon: ArrowLeftRight,
    getValue: (d: StatsData) => formatNumber(d.totalTransactions),
  },
  {
    key: 'volume' as const,
    label: 'Total Volume',
    icon: DollarSign,
    getValue: (d: StatsData) => formatUsdc(d.totalVolumeUsdc),
  },
  {
    key: 'trusted' as const,
    label: 'Trusted Agents',
    icon: Shield,
    getValue: (d: StatsData) => {
      const good = (d.tierDistribution['Good'] ?? 0)
        + (d.tierDistribution['Very Good'] ?? 0)
        + (d.tierDistribution['Excellent'] ?? 0);
      return formatNumber(good);
    },
  },
];

export function StatsCards({ data }: { data: StatsData }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {STAT_ITEMS.map((item) => (
        <div
          key={item.key}
          className="rounded-lg border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] p-4"
        >
          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-[rgb(255_255_255/0.04)]">
              <item.icon className="size-4 text-[#8a8f98]" />
            </div>
            <div className="min-w-0">
              <p className="text-xl font-[510] tabular-nums leading-none tracking-[-0.288px] text-[#f7f8f8]">
                {item.getValue(data)}
              </p>
              <p className="mt-1 text-xs font-[510] text-[#62666d]">{item.label}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
