'use client';

import { useEffect, useState } from 'react';

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
      className="inline-flex items-center gap-2 rounded-full border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.02)] py-1 pl-2 pr-3 text-[11.5px] text-[#8a8f98] backdrop-blur-sm animate-in fade-in duration-500"
    >
      <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#7170ff] opacity-50" />
        <span className="relative inline-flex size-1.5 rounded-full bg-[#7170ff]" />
      </span>
      <span className="text-[#62666d]">Last settled</span>
      <span className="font-mono text-[#d0d6e0]" suppressHydrationWarning>
        {shortAddr(tx.walletAddress)}
      </span>
      <span className="text-[#62666d]">·</span>
      <span className="tabular-nums text-[#d0d6e0]">{tx.amount.toFixed(2)} USDC</span>
      <span className="text-[#62666d]">·</span>
      <span className="tabular-nums text-[#62666d]" suppressHydrationWarning>
        {/* tick is a dep so this re-renders every second */}
        {tick >= 0 ? timeAgo(tx.timestamp) : ''}
      </span>
    </div>
  );
}
