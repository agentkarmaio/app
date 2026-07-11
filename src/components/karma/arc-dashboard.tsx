/**
 * Arc grant-demo dashboard band — server-safe, no "use client".
 *
 * KPI strip + quality histogram + recent matched settlements + secondary
 * registry mirror. Renders honest zeros when AK has no matched Arc settlements.
 */

import { ArrowLeftRight, DollarSign, ExternalLink, ShieldCheck, Users } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { SettlementQualityPill } from '@/components/settlement-quality-badge';
import { WalletAddress } from '@/components/karma/wallet-address';
import { arcTestnet } from '@/config/arc-chain';
import { formatUsdcAmount } from '@/lib/format';
import type { ArcDashboardStats, ArcQualityHistogram } from '@/lib/arc-dashboard-stats';
import type { SettlementLabel } from '@/scoring/settlement-quality';

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatVolume(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return formatUsdcAmount(n, true);
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function explorerTx(hash: string): string {
  return `${arcTestnet.blockExplorers.default.url}/tx/${hash}`;
}

function explorerAddress(addr: string): string {
  return `${arcTestnet.blockExplorers.default.url}/address/${addr}`;
}

const KPI = [
  {
    key: 'settlements',
    label: 'Matched Settlements',
    icon: ArrowLeftRight,
    value: (d: ArcDashboardStats) => formatCount(d.matchedSettlements),
  },
  {
    key: 'volume',
    label: 'USDC Volume',
    icon: DollarSign,
    value: (d: ArcDashboardStats) => formatVolume(d.volumeUsdc),
    accent: true,
  },
  {
    key: 'agents',
    label: 'Agents with Receipts',
    icon: Users,
    value: (d: ArcDashboardStats) => formatCount(d.agentsWithReceipts),
  },
  {
    key: 'reliable',
    label: 'Reliable Agents',
    icon: ShieldCheck,
    value: (d: ArcDashboardStats) => formatCount(d.quality.reliable),
  },
] as const;

function QualityBar({ quality }: { quality: ArcQualityHistogram }) {
  const total = quality.reliable + quality.mixed + quality.unproven;
  const rows: { label: SettlementLabel; count: number; bar: string }[] = [
    { label: 'reliable', count: quality.reliable, bar: 'bg-emerald-400' },
    { label: 'mixed', count: quality.mixed, bar: 'bg-amber-400' },
    { label: 'unproven', count: quality.unproven, bar: 'bg-slate-400' },
  ];

  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const pct = total > 0 ? Math.round((row.count / total) * 100) : 0;
        return (
          <div key={row.label} className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <SettlementQualityPill label={row.label} />
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {formatCount(row.count)}
                {total > 0 ? ` · ${pct}%` : ''}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className={`h-full rounded-full ${row.bar} transition-[width]`}
                style={{ width: total > 0 ? `${Math.max(pct, row.count > 0 ? 2 : 0)}%` : '0%' }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ArcDashboard({ data }: { data: ArcDashboardStats }) {
  return (
    <section className="mb-10 space-y-6" data-tour="arc-dashboard">
      {/* KPI strip */}
      <div className="overflow-hidden rounded-lg border border-slate-400/20 bg-slate-400/[0.03]">
        <div className="flex items-center justify-between gap-3 border-b border-[rgb(255_255_255/0.06)] px-4 py-2.5 sm:px-5">
          <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-slate-300">
            <span className="size-1.5 rounded-full bg-emerald-400" />
            AK-scored Arc signal · matched ERC-8183 only
          </div>
          <span className="text-[10px] text-muted-foreground">USDC · Arc Testnet</span>
        </div>
        <div className="grid grid-cols-2 divide-[rgb(255_255_255/0.06)] sm:grid-cols-4 sm:divide-x sm:divide-y-0 divide-y">
          {KPI.map((item) => (
            <div key={item.key} className="px-4 py-4 sm:px-5">
              <div className="flex items-center gap-1.5">
                <item.icon className="size-3 text-[#62666d]" strokeWidth={1.75} />
                <p className="text-[10px] font-[510] uppercase tracking-[0.12em] text-[#62666d]">
                  {item.label}
                </p>
              </div>
              <p
                className={
                  'accent' in item && item.accent
                    ? 'mt-1.5 text-[22px] font-[560] tabular-nums leading-none tracking-[-0.6px] text-[#828fff]'
                    : 'mt-1.5 text-[22px] font-[560] tabular-nums leading-none tracking-[-0.6px] text-[#f7f8f8]'
                }
              >
                {item.value(data)}
              </p>
            </div>
          ))}
        </div>
        {data.empty && (
          <p className="border-t border-[rgb(255_255_255/0.06)] px-4 py-3 text-xs text-muted-foreground sm:px-5">
            No matched Arc settlements indexed yet — awaiting ERC-8183{' '}
            <span className="font-mono text-foreground">PaymentReleased</span> ⋈{' '}
            <span className="font-mono text-foreground">JobCreated</span> pairs on Arc Testnet.
            Numbers stay at zero rather than fabricated.
          </p>
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Quality distribution */}
        <Card className="border-slate-400/15">
          <CardContent className="p-6">
            <h2 className="mb-1 text-base font-semibold tracking-tight">Settlement quality</h2>
            <p className="mb-4 text-xs text-muted-foreground">
              Distinct independent counterparties — not review count. Farmed wash patterns read{' '}
              <span className="inline-flex items-center gap-1">
                <span aria-hidden className="size-1.5 rounded-full bg-slate-400" />
                Unproven.
              </span>
            </p>
            {data.agentsWithReceipts === 0 && data.quality.reliable + data.quality.mixed + data.quality.unproven === 0 ? (
              <p className="text-sm text-muted-foreground">No receipt-backed agents yet.</p>
            ) : (
              <QualityBar quality={data.quality} />
            )}
          </CardContent>
        </Card>

        {/* Registry secondary */}
        <Card className="border-slate-400/15">
          <CardContent className="p-6">
            <h2 className="mb-1 text-base font-semibold tracking-tight">On-chain surface</h2>
            <p className="mb-4 text-xs text-muted-foreground">
              ERC-8004 registry mirror — secondary. Testnet is farmed-heavy; AK does not score from
              raw registry headcount.
            </p>
            <dl className="grid gap-3 text-sm sm:grid-cols-[9rem_1fr]">
              <dt className="text-muted-foreground">Mirrored agents</dt>
              <dd className="font-mono tabular-nums">{formatCount(data.registry.agents)}</dd>
              <dt className="text-muted-foreground">Feedback records</dt>
              <dd className="font-mono tabular-nums">{formatCount(data.registry.feedbacks)}</dd>
            </dl>
            <p className="mt-4 rounded-md border border-slate-400/30 bg-slate-400/[0.06] px-3 py-2 text-xs text-muted-foreground">
              Headline KPIs above count only matched USDC settlements AK indexed — not these
              registry totals.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Recent matched settlements */}
      <Card className="border-slate-400/15">
        <CardContent className="p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold tracking-tight">Recent matched settlements</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                ERC-8183 job escrow · USDC · live from AK&apos;s Arc indexer
              </p>
            </div>
            <a
              href={arcTestnet.blockExplorers.default.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Arcscan
              <ExternalLink className="size-3" />
            </a>
          </div>

          {data.recent.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              No matched settlements yet. When jobs clear escrow on Arc, they appear here with
              Arcscan links.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    <th className="pb-2 pr-3 font-medium">When</th>
                    <th className="pb-2 pr-3 font-medium">Client</th>
                    <th className="pb-2 pr-3 font-medium">Provider</th>
                    <th className="pb-2 pr-3 text-right font-medium">USDC</th>
                    <th className="pb-2 text-right font-medium">Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((row) => (
                    <tr
                      key={row.txSignature}
                      className="border-b border-border/50 last:border-0"
                    >
                      <td className="py-2.5 pr-3 text-xs text-muted-foreground whitespace-nowrap">
                        {shortTime(row.timestamp)}
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-xs">
                        <WalletAddress
                          address={row.walletAddress}
                          href={`/agent/${row.walletAddress}?chain=arc`}
                          className="text-xs"
                        />
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-xs">
                        {row.counterparty ? (
                          <WalletAddress
                            address={row.counterparty}
                            href={explorerAddress(row.counterparty)}
                            className="text-xs"
                          />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono text-xs tabular-nums text-[#828fff]">
                        {formatUsdcAmount(row.amount, true)}
                      </td>
                      <td className="py-2.5 text-right">
                        <a
                          href={explorerTx(row.txHash)}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        >
                          {row.txHash.slice(0, 6)}…{row.txHash.slice(-4)}
                          <ExternalLink className="size-3" />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
