'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatUsdcAmount } from '@/lib/format';

interface Tx {
  walletAddress: string;
  amount: number;
  timestamp: string;
  signature: string;
}

function shortAddr(a: string) {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function timeAgo(iso: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function LiveTicker() {
  const [tx, setTx] = useState<Tx | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch('/api/explore?limit=1', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        const t = data.transactions?.[0];
        if (t && !cancelled) {
          setTx({
            walletAddress: t.wallet_address,
            amount: Number(t.amount),
            timestamp: t.timestamp,
            signature: t.tx_signature,
          });
        }
      } catch {}
    }

    load();
    const poll = setInterval(load, 15_000);
    const refresh = setInterval(() => setTick((t) => t + 1), 1000);

    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(refresh);
    };
  }, []);

  if (!tx) return null;

  return (
    <div
      key={tx.signature}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[#62666d] animate-in fade-in duration-500"
    >
      <span className="relative flex size-1">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#7170ff] opacity-60" />
        <span className="relative inline-flex size-1 rounded-full bg-[#7170ff]" />
      </span>
      <span className="uppercase tracking-[0.08em]">Last settled</span>
      <Link
        href={`/agent/${tx.walletAddress}`}
        className="font-mono text-[#d0d6e0] underline-offset-4 decoration-[rgb(255_255_255/0.12)] transition-colors hover:text-[#f7f8f8] hover:decoration-[rgb(113_112_255/0.5)] hover:underline"
        suppressHydrationWarning
      >
        {shortAddr(tx.walletAddress)}
      </Link>
      <span className="text-[rgb(255_255_255/0.12)]">·</span>
      <span className="tabular-nums text-[#d0d6e0]">
        {formatUsdcAmount(tx.amount)}
        <span className="ml-0.5 text-[#62666d]">USDC</span>
      </span>
      <span className="text-[rgb(255_255_255/0.12)]">·</span>
      <span className="tabular-nums" suppressHydrationWarning>
        {tick >= 0 ? timeAgo(tx.timestamp) : ''}
      </span>
    </div>
  );
}
