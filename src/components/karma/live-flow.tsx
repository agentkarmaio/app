'use client';

import { useEffect, useRef, useState } from 'react';

interface Stats {
  totalAgents: number;
  totalTransactions: number;
}

function useCountUp(value: number, duration = 900) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const startRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (value === display) return;
    fromRef.current = display;
    startRef.current = null;
    const target = value;

    function tick(ts: number) {
      if (startRef.current === null) startRef.current = ts;
      const t = Math.min(1, (ts - startRef.current) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = Math.round(fromRef.current + (target - fromRef.current) * eased);
      setDisplay(next);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return display;
}

export function LiveFlow() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [pulseKey, setPulseKey] = useState(0);
  const prevTxRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/stats', { cache: 'no-store' });
        if (!res.ok) return;
        const data: Stats = await res.json();
        if (cancelled) return;
        setStats(data);
        if (prevTxRef.current !== null && data.totalTransactions > prevTxRef.current) {
          setPulseKey((k) => k + 1);
        }
        prevTxRef.current = data.totalTransactions;
      } catch {}
    }
    load();
    const id = setInterval(load, 6000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const txs = useCountUp(stats?.totalTransactions ?? 0);
  const agents = useCountUp(stats?.totalAgents ?? 0);
  const loaded = stats !== null;

  return (
    <div
      aria-label="Live indexing stream"
      className="pointer-events-none inline-flex items-center gap-2 text-[10.5px] font-[510] text-[#62666d]"
      style={{ visibility: loaded ? 'visible' : 'hidden' }}
    >
      <span className="uppercase tracking-[0.12em] text-[#62666d]">
        Streaming
      </span>

      <span className="relative h-px w-8 overflow-hidden">
        <span className="absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-[rgb(113_112_255/0.6)] to-transparent karma-live-sweep" />
      </span>

      <span
        key={`tx-${pulseKey}`}
        className="inline-block text-right font-mono tabular-nums text-[#8a8f98] karma-live-flash"
        style={{ minWidth: '3.5em' }}
      >
        {loaded ? txs.toLocaleString() : '000,000'}
      </span>
      <span className="text-[#4f5258]">tx</span>

      <span aria-hidden className="text-[rgb(255_255_255/0.1)]">·</span>

      <span
        className="inline-block text-right font-mono tabular-nums text-[#8a8f98]"
        style={{ minWidth: '2.8em' }}
      >
        {loaded ? agents.toLocaleString() : '00,000'}
      </span>
      <span className="text-[#4f5258]">agents</span>
    </div>
  );
}
