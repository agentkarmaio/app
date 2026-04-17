'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { getFacilitatorName } from '@/config/facilitators';
import { formatUsdcAmount } from '@/lib/format';

type FeedbackRating = 'delivered' | 'failed' | null;

interface TxRow {
  id: string;
  facilitator: string;
  amount: number;
  timestamp: string;
  success: boolean;
  tx_signature: string;
  feedback?: FeedbackRating;
}

interface ApiTx {
  id: string;
  facilitator: string;
  amount: number | string;
  timestamp: string;
  success: boolean;
  txSignature: string;
  feedback?: FeedbackRating;
}

function relativeTime(iso: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d ago`;
  return `${Math.floor(s / 2592000)}mo ago`;
}

function FeedbackPill({ rating }: { rating: FeedbackRating }) {
  if (!rating) {
    return <span className="text-[11px] text-[#4f5258]">—</span>;
  }
  const delivered = rating === 'delivered';
  return (
    <span
      className={
        delivered
          ? 'inline-flex items-center gap-1 rounded-md border border-[rgb(16_185_129/0.20)] bg-[rgb(16_185_129/0.10)] px-1.5 py-0.5 text-[11px] font-[510] text-[#10b981]'
          : 'inline-flex items-center gap-1 rounded-md border border-[rgb(229_72_77/0.20)] bg-[rgb(229_72_77/0.10)] px-1.5 py-0.5 text-[11px] font-[510] text-[#e5484d]'
      }
      title={`Consumer reported this payment as ${delivered ? 'delivered' : 'failed'}`}
    >
      {delivered ? 'Delivered' : 'Failed'}
    </span>
  );
}

function TxSignature({ signature }: { signature: string }) {
  return (
    <a
      href={`https://solscan.io/tx/${signature}`}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-xs text-[#62666d] hover:text-[#8a8f98] transition-colors"
    >
      {signature.slice(0, 8)}...
    </a>
  );
}

interface Props {
  transactions: TxRow[];
  walletAddress?: string;
  total?: number;
  pageSize?: number;
}

export function TransactionList({
  transactions: initial,
  walletAddress,
  total,
  pageSize = 25,
}: Props) {
  const [rows, setRows] = useState<TxRow[]>(initial);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(
    !walletAddress || total === undefined || initial.length >= total,
  );
  const sentinelRef = useRef<HTMLTableRowElement | null>(null);

  const loadMore = useCallback(async () => {
    if (loading || done || !walletAddress) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/agent/${walletAddress}/history?limit=${pageSize}&offset=${rows.length}`,
      );
      if (!res.ok) throw new Error('history fetch failed');
      const data = (await res.json()) as { transactions: ApiTx[]; total: number };
      const next: TxRow[] = data.transactions.map((tx) => ({
        id: tx.id,
        facilitator: tx.facilitator,
        amount: Number(tx.amount),
        timestamp: tx.timestamp,
        success: tx.success,
        tx_signature: tx.txSignature,
        feedback: tx.feedback ?? null,
      }));
      setRows((prev) => {
        const combined = [...prev, ...next];
        if (combined.length >= data.total || next.length < pageSize) setDone(true);
        return combined;
      });
    } catch {
      setDone(true);
    } finally {
      setLoading(false);
    }
  }, [loading, done, walletAddress, pageSize, rows.length]);

  useEffect(() => {
    if (done || !sentinelRef.current) return;
    const el = sentinelRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore, done, rows.length]);

  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No transactions recorded yet.
      </p>
    );
  }

  const showDelivery = rows.some((tx) => tx.feedback);

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Facilitator</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-center">Status</TableHead>
          {showDelivery && (
            <TableHead className="text-center hidden md:table-cell">Delivery</TableHead>
          )}
          <TableHead className="text-right hidden sm:table-cell">Date</TableHead>
          <TableHead className="text-right hidden md:table-cell">Signature</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((tx) => {
          const facilitatorName = getFacilitatorName(tx.facilitator);
          return (
            <TableRow key={tx.id}>
              <TableCell className="font-medium capitalize">
                <span
                  title={tx.facilitator}
                  className="cursor-help underline-offset-4 decoration-dotted decoration-[rgb(255_255_255/0.12)] hover:underline"
                >
                  {facilitatorName ?? tx.facilitator.slice(0, 8) + '...'}
                </span>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <span title={`${Number(tx.amount).toFixed(6)} USDC`}>
                  {formatUsdcAmount(Number(tx.amount), true)}
                </span>
              </TableCell>
              <TableCell className="text-center">
                <Badge
                  variant="outline"
                  className={
                    tx.success
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-400'
                      : 'border-red-200 bg-red-50 text-red-600 dark:border-red-800 dark:bg-red-950 dark:text-red-400'
                  }
                >
                  {tx.success ? 'OK' : 'Failed'}
                </Badge>
              </TableCell>
              {showDelivery && (
                <TableCell className="text-center hidden md:table-cell">
                  <FeedbackPill rating={tx.feedback ?? null} />
                </TableCell>
              )}
              <TableCell className="text-right text-sm text-muted-foreground hidden sm:table-cell tabular-nums">
                <div
                  className="flex flex-col items-end leading-tight"
                  title={new Date(tx.timestamp).toLocaleString()}
                  suppressHydrationWarning
                >
                  <span className="whitespace-nowrap">
                    {new Date(tx.timestamp).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                    <span className="text-[#4f5258]">
                      {' · '}
                    </span>
                    {new Date(tx.timestamp).toLocaleTimeString('en-US', {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </span>
                  <span className="text-[11px] text-[#4f5258]" suppressHydrationWarning>
                    {relativeTime(tx.timestamp)}
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-right hidden md:table-cell">
                <TxSignature signature={tx.tx_signature} />
              </TableCell>
            </TableRow>
          );
        })}
        {!done && (
          <TableRow ref={sentinelRef} className="hover:bg-transparent">
            <TableCell
              colSpan={showDelivery ? 6 : 5}
              className="py-4 text-center text-xs text-muted-foreground"
            >
              {loading ? 'Loading more\u2026' : '\u00a0'}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
