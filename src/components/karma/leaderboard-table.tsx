import Link from 'next/link';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { TierBadge } from '@/components/karma/tier-badge';
import { ConfidenceBadge } from '@/components/karma/confidence-badge';
import { AutonomyChip } from '@/components/karma/autonomy-chip';
import { ChainBadge } from '@/components/karma/chain-badge';
import { AgentAvatar } from '@/components/karma/agent-avatar';
import { agentHref } from '@/lib/agent-href';
import { WalletAddress } from '@/components/karma/wallet-address';
import { LivenessIndicator } from '@/components/karma/liveness-indicator';
import { Sparkline } from '@/components/karma/sparkline';
import type {
  TrustTier, ConfidenceBadge as ConfidenceBadgeValue, AutonomyLabel, Chain,
} from '@/db/schema';

export interface LeaderboardEntry {
  rank: number;
  address: string;
  chain: Chain;
  displayName?: string | null;
  imageUrl?: string | null;
  score: number;
  trustTier: TrustTier;
  confidenceBadge?: ConfidenceBadgeValue | null;
  autonomyScore?: number | null;
  autonomyLabel?: AutonomyLabel | null;
  txCount: number;
  lastSeen: string;
  delivery?: { total: number; deliveryRate: number } | null;
  trend?: number[];
}

export function LeaderboardTable({
  entries,
  pulsingAddresses,
}: {
  entries: LeaderboardEntry[];
  pulsingAddresses?: Set<string>;
}) {
  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <p className="text-sm">No agents scored yet.</p>
        <p className="mt-1 text-xs">Run the indexer to start tracking x402 payments.</p>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-12 text-center">#</TableHead>
          <TableHead>Agent Wallet</TableHead>
          <TableHead className="text-center">Score</TableHead>
          <TableHead className="text-center hidden md:table-cell">Trend</TableHead>
          <TableHead className="text-center">Tier</TableHead>
          <TableHead className="text-center hidden lg:table-cell">Confidence</TableHead>
          <TableHead className="text-center hidden lg:table-cell" title="Autonomy Confidence — is this counterparty actually an autonomous agent?">Autonomy</TableHead>
          <TableHead className="text-center hidden md:table-cell">Delivery</TableHead>
          <TableHead className="text-right">Transactions</TableHead>
          <TableHead className="text-right hidden sm:table-cell">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow
            // Composite key: EVM addresses (Celo + Arc) share the 0x40hex
            // format, so the same address can appear once per chain. Keying
            // on address alone collides and React merges the rows.
            key={`${entry.chain}:${entry.address}`}
            className={pulsingAddresses?.has(entry.address) ? 'karma-row-pulse' : undefined}
          >
            <TableCell className="text-center font-medium text-muted-foreground tabular-nums">
              {entry.rank}
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-2 min-w-0">
                <AgentAvatar
                  src={entry.imageUrl}
                  name={entry.displayName ?? entry.address}
                  size={22}
                  className="rounded-md"
                />
                <ChainBadge chain={entry.chain} />
                <Link
                  href={agentHref(entry)}
                  className="hover:underline underline-offset-4 min-w-0 truncate"
                >
                  {entry.displayName ? (
                    <span className="text-[13px] font-[510] text-[#f7f8f8]">{entry.displayName}</span>
                  ) : (
                    <WalletAddress address={entry.address} copyable={false} />
                  )}
                </Link>
              </div>
            </TableCell>
            <TableCell className="text-center font-bold tabular-nums">
              {Number(entry.score).toFixed(1)}
            </TableCell>
            <TableCell className="text-center hidden md:table-cell">
              {entry.trend && entry.trend.length >= 2 ? (
                <Sparkline points={entry.trend} className="inline-block align-middle" />
              ) : (
                <span className="text-[11px] text-[#62666d]">—</span>
              )}
            </TableCell>
            <TableCell className="text-center">
              <TierBadge tier={entry.trustTier} size="sm" />
            </TableCell>
            <TableCell className="text-center hidden lg:table-cell">
              {entry.confidenceBadge ? (
                <ConfidenceBadge badge={entry.confidenceBadge} size="sm" />
              ) : (
                <span className="text-[11px] text-[#62666d]">—</span>
              )}
            </TableCell>
            <TableCell className="text-center hidden lg:table-cell">
              {entry.autonomyScore != null && entry.autonomyLabel ? (
                <AutonomyChip score={entry.autonomyScore} label={entry.autonomyLabel} size="sm" />
              ) : (
                <span className="text-[11px] text-[#62666d]">—</span>
              )}
            </TableCell>
            <TableCell className="text-center hidden md:table-cell">
              {entry.delivery && entry.delivery.total > 0 ? (
                <DeliveryPill rate={entry.delivery.deliveryRate} count={entry.delivery.total} />
              ) : (
                <span className="text-[11px] text-[#62666d]">—</span>
              )}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {entry.txCount.toLocaleString()}
            </TableCell>
            <TableCell className="text-right hidden sm:table-cell">
              <LivenessIndicator lastSeen={entry.lastSeen} size="sm" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function DeliveryPill({ rate, count }: { rate: number; count: number }) {
  const pct = Math.round(rate * 100);
  const color =
    pct >= 90 ? 'text-[#10b981] bg-[rgb(16_185_129/0.10)] border-[rgb(16_185_129/0.20)]'
    : pct >= 70 ? 'text-[#d0d6e0] bg-[rgb(255_255_255/0.04)] border-[rgb(255_255_255/0.08)]'
    : 'text-[#e5484d] bg-[rgb(229_72_77/0.10)] border-[rgb(229_72_77/0.20)]';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-[510] tabular-nums ${color}`}
      title={`${count} consumer feedback${count === 1 ? '' : 's'}`}
    >
      {pct}%
      <span className="text-[10px] opacity-60">·{count}</span>
    </span>
  );
}
