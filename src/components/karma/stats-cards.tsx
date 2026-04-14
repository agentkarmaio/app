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
  featured?: boolean;
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
    featured: true,
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
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {STAT_ITEMS.map((item) => {
        const featured = item.featured;
        return (
          <div
            key={item.key}
            className={
              featured
                ? 'relative overflow-hidden rounded-lg border border-[rgb(113_112_255/0.25)] bg-gradient-to-br from-[rgb(94_106_210/0.12)] to-[rgb(94_106_210/0.02)] p-5'
                : 'rounded-lg border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] p-5'
            }
          >
            {featured && (
              <div
                aria-hidden
                className="pointer-events-none absolute -right-8 -top-8 size-32 rounded-full bg-[#5e6ad2] opacity-[0.08] blur-2xl"
              />
            )}
            <div className="flex items-center gap-2">
              <item.icon
                className={
                  featured
                    ? 'size-3.5 text-[#7170ff]'
                    : 'size-3.5 text-[#62666d]'
                }
              />
              <p
                className={
                  featured
                    ? 'text-[11px] font-[510] uppercase tracking-[0.08em] text-[#7170ff]'
                    : 'text-[11px] font-[510] uppercase tracking-[0.08em] text-[#62666d]'
                }
              >
                {item.label}
              </p>
            </div>
            <p className="mt-3 text-[36px] font-[560] tabular-nums leading-none tracking-[-1.2px] text-[#f7f8f8]">
              {item.getValue(data)}
            </p>
          </div>
        );
      })}
    </div>
  );
}
