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

type StatItem = {
  key: string;
  label: string;
  icon: typeof Users;
  getValue: (d: StatsData) => string;
  accent?: boolean;
};

const STAT_ITEMS: StatItem[] = [
  {
    key: 'agents',
    label: 'Tracked Agents',
    icon: Users,
    getValue: (d) => formatNumber(d.totalAgents),
  },
  {
    key: 'txs',
    label: 'Payments Settled',
    icon: ArrowLeftRight,
    getValue: (d) => formatNumber(d.totalTransactions),
  },
  {
    key: 'volume',
    label: 'USDC Volume',
    icon: DollarSign,
    getValue: (d) => formatUsdc(d.totalVolumeUsdc),
    accent: true,
  },
  {
    key: 'trusted',
    label: 'Trusted Agents',
    icon: Shield,
    getValue: (d) => {
      const good = (d.tierDistribution['Good'] ?? 0)
        + (d.tierDistribution['Very Good'] ?? 0)
        + (d.tierDistribution['Excellent'] ?? 0);
      return formatNumber(good);
    },
  },
];

export function StatsCards({ data }: { data: StatsData }) {
  return (
    <div className="grid grid-cols-2 divide-[rgb(255_255_255/0.06)] border-y border-[rgb(255_255_255/0.06)] sm:grid-cols-4 sm:divide-x">
      {STAT_ITEMS.map((item) => (
        <div key={item.key} className="px-4 py-4 sm:px-5">
          <div className="flex items-center gap-1.5">
            <item.icon className="size-3 text-[#62666d]" strokeWidth={1.75} />
            <p className="text-[10px] font-[510] uppercase tracking-[0.12em] text-[#62666d]">
              {item.label}
            </p>
          </div>
          <p
            className={
              item.accent
                ? 'mt-1.5 text-[22px] font-[560] tabular-nums leading-none tracking-[-0.6px] text-[#828fff]'
                : 'mt-1.5 text-[22px] font-[560] tabular-nums leading-none tracking-[-0.6px] text-[#f7f8f8]'
            }
          >
            {item.getValue(data)}
          </p>
        </div>
      ))}
    </div>
  );
}
