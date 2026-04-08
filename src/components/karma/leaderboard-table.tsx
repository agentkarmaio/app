import Link from 'next/link';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { TierBadge } from '@/components/karma/tier-badge';
import { WalletAddress } from '@/components/karma/wallet-address';
import { LivenessIndicator } from '@/components/karma/liveness-indicator';
import type { TrustTier } from '@/db/schema';

export interface LeaderboardEntry {
  rank: number;
  address: string;
  displayName?: string | null;
  score: number;
  trustTier: TrustTier;
  txCount: number;
  lastSeen: string;
}

export function LeaderboardTable({ entries }: { entries: LeaderboardEntry[] }) {
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
          <TableHead className="text-center">Tier</TableHead>
          <TableHead className="text-right">Transactions</TableHead>
          <TableHead className="text-right hidden sm:table-cell">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow key={entry.address}>
            <TableCell className="text-center font-medium text-muted-foreground tabular-nums">
              {entry.rank}
            </TableCell>
            <TableCell>
              <Link
                href={`/agent/${entry.address}`}
                className="hover:underline underline-offset-4"
              >
                {entry.displayName ? (
                  <span className="text-[13px] font-[510] text-[#f7f8f8]">{entry.displayName}</span>
                ) : (
                  <WalletAddress address={entry.address} copyable={false} />
                )}
              </Link>
            </TableCell>
            <TableCell className="text-center font-bold tabular-nums">
              {Number(entry.score).toFixed(1)}
            </TableCell>
            <TableCell className="text-center">
              <TierBadge tier={entry.trustTier} size="sm" />
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
