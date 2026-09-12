'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { IndexingHealth } from '@/lib/indexing-health';
import {
  activityStatus, INDEXING_STATUS_LABELS, parseActivityStats, parseActivityHealth, startActivityPoll, type ActivityStats,
} from './live-flow-state';

const CHAIN_LABELS = { solana: 'Solana', arc: 'Arc testnet', 'arc-mainnet': 'Arc mainnet', celo: 'Celo', stellar: 'Stellar' };

function CheckedTime({ value, empty }: { value: string | null | undefined; empty: string }) {
  if (!value || !Number.isFinite(Date.parse(value))) return <span>{empty}</span>;
  return <time dateTime={value}>{new Date(value).toLocaleString('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  })} UTC</time>;
}

export function LiveFlow({ initial }: { initial?: ActivityStats }) {
  const [stats, setStats] = useState<ActivityStats | null>(initial ?? null);
  const [health, setHealth] = useState<IndexingHealth | null>(null);
  const [statsFailed, setStatsFailed] = useState(false);
  const [healthFailed, setHealthFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [pulseKey, setPulseKey] = useState(0);
  const prevTxRef = useRef<number | null>(initial?.totalTransactions ?? null);
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const stopStats = startActivityPoll({
      load: async (signal) => {
        const response = await fetch('/api/stats', { cache: 'no-store', signal });
        if (!response.ok) throw new Error('Counts unavailable');
        return parseActivityStats(await response.json());
      },
      receive: (data) => {
        setStats(data);
        setStatsFailed(false);
        if (prevTxRef.current !== null && data.totalTransactions > prevTxRef.current) setPulseKey((key) => key + 1);
        prevTxRef.current = data.totalTransactions;
      },
      failed: () => setStatsFailed(true),
      intervalMs: 6000,
    });
    const stopHealth = startActivityPoll({
      load: async (signal) => {
        const response = await fetch('/api/v2/indexing/status', { cache: 'no-store', signal });
        if (!response.ok) throw new Error('Coverage unavailable');
        return parseActivityHealth(await response.json());
      },
      receive: (data) => { setHealth(data); setHealthFailed(false); },
      failed: () => setHealthFailed(true),
      intervalMs: 30000,
    });
    return () => { stopStats(); stopHealth(); };
  }, [refresh]);

  const status = activityStatus(stats, health, statsFailed, healthFailed);
  const delayed = status === 'Updates delayed';

  return (
    <div aria-label="Indexed activity" className="relative inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-[510] text-muted-foreground">
      <details
        ref={detailsRef}
        className="group"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && detailsRef.current?.open) {
            detailsRef.current.open = false;
            detailsRef.current.querySelector('summary')?.focus();
          }
        }}
      >
        <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1 rounded px-1 uppercase tracking-[0.12em] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          Indexed activity
          <ChevronDown aria-hidden="true" className="size-3 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
        </summary>
        <div className="absolute left-0 top-full z-40 mt-2 max-h-[70vh] w-[min(28rem,calc(100vw-3rem))] overflow-y-auto rounded-lg border border-border bg-popover p-4 text-xs font-normal text-popover-foreground shadow-lg">
          <p className="font-medium">Network coverage</p>
          <p className="mt-1 text-muted-foreground">Relevant agent activity across supported networks. Mainnet and testnet records are kept separate. Counts include previously indexed receipts.</p>
          {healthFailed && <p className="mt-3 text-muted-foreground">Status updates are delayed. Showing the last available report.</p>}
          {health ? (
            <div className="mt-4 space-y-4">
              {health.chains.map((chain) => (
                <section key={chain.chain} aria-label={`${CHAIN_LABELS[chain.chain]} indexing`}>
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="font-medium">{CHAIN_LABELS[chain.chain]}</h3>
                    <span className="text-muted-foreground">{INDEXING_STATUS_LABELS[chain.status]}</span>
                  </div>
                  <ul className="mt-2 space-y-2 border-l border-border pl-3">
                    {chain.paths.map((path) => (
                      <li key={path.path}>
                        <div className="flex items-baseline justify-between gap-2">
                          <span>{path.label}</span>
                          <span className="text-right text-muted-foreground">{INDEXING_STATUS_LABELS[path.status]}</span>
                        </div>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">Last checked: <CheckedTime value={path.lastCheckedAt} empty="Never checked" /></p>
                        <p className="text-[11px] text-muted-foreground">Last complete scan: <CheckedTime value={path.lastSuccessAt} empty="Not yet completed" /></p>
                        {path.unresolved > 0 && <p className="text-[11px] text-muted-foreground">At least {path.unresolved.toLocaleString('en-US')} coverage issues</p>}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : <p className="mt-4 text-muted-foreground">{healthFailed ? 'Network status is unavailable. Retrying automatically.' : 'Checking network status…'}</p>}
          <div className="mt-4 border-t border-border pt-3 text-[11px] text-muted-foreground">
            <p>Transaction count checked: <CheckedTime value={stats?.freshness?.transactionsUpdatedAt} empty="Time unavailable" /></p>
            <p>Agent count checked: <CheckedTime value={stats?.freshness?.agentsUpdatedAt} empty="Time unavailable" /></p>
            {delayed && <p className="mt-2">Updates delayed. Existing counts are preserved; checks retry automatically.</p>}
            <button type="button" onClick={() => setRefresh((value) => value + 1)} className="mt-2 min-h-10 rounded px-2 text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Check again</button>
          </div>
        </div>
      </details>
      {stats ? (
        <span className="inline-flex items-center gap-2">
          <span key={`tx-${pulseKey}`} className="font-mono tabular-nums karma-live-flash motion-reduce:animate-none">{stats.totalTransactions.toLocaleString('en-US')}</span>
          <span>receipts</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono tabular-nums">{stats.totalAgents.toLocaleString('en-US')}</span>
          <span>agents</span>
        </span>
      ) : <span>{statsFailed ? 'Counts unavailable' : 'Loading counts…'}</span>}
      <span role="status" className={delayed ? 'text-foreground' : 'text-muted-foreground'}>{status}</span>
    </div>
  );
}
