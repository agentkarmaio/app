'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { getFacilitatorName } from '@/config/facilitators';

interface TxRow {
  id: string;
  facilitator: string;
  amount: number;
  timestamp: string;
  success: boolean;
  tx_signature: string;
}

interface ApiTx {
  id: string;
  facilitator: string;
  amount: number | string;
  timestamp: string;
  success: boolean;
  txSignature: string;
}

function formatUsdc(amount: number): string {
  if (!Number.isFinite(amount) || amount === 0) return '$0.00';
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(3)}`;
  if (amount >= 0.0001) return `$${amount.toFixed(4)}`;
  return `<$0.0001`;
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

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Facilitator</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-center">Status</TableHead>
          <TableHead className="text-right hidden sm:table-cell">Date</TableHead>
          <TableHead className="text-right hidden md:table-cell">Signature</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((tx) => (
          <TableRow key={tx.id}>
            <TableCell className="font-medium capitalize">
              {getFacilitatorName(tx.facilitator) ?? tx.facilitator.slice(0, 8) + '...'}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatUsdc(Number(tx.amount))}
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
            <TableCell className="text-right text-sm text-muted-foreground hidden sm:table-cell">
              {new Date(tx.timestamp).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </TableCell>
            <TableCell className="text-right hidden md:table-cell">
              <TxSignature signature={tx.tx_signature} />
            </TableCell>
          </TableRow>
        ))}
        {!done && (
          <TableRow ref={sentinelRef} className="hover:bg-transparent">
            <TableCell
              colSpan={5}
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
