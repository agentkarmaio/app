'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import type { IndexingHealth, IndexingStatus } from '@/lib/indexing-health';
import {
  activeActivityChains, activityStatus, activityTone, INDEXING_ISSUE_MESSAGES, INDEXING_STATUS_LABELS, INDEXING_STATUS_TONES,
  parseActivityHealth, parseActivityStats, startActivityPoll, type ActivityStats, type StatusTone,
} from './live-flow-state';

const CHAIN_LABELS: Record<string, string> = { solana: 'Solana', 'arc-mainnet': 'Arc', celo: 'Celo', stellar: 'Stellar' };

const TONE_DOT: Record<StatusTone, string> = {
  ok: 'bg-emerald-400',
  busy: 'bg-sky-400',
  warn: 'bg-amber-400',
  error: 'bg-red-400',
  idle: 'bg-muted-foreground/50',
};

function StatusDot({ tone, pulse = false }: { tone: StatusTone; pulse?: boolean }) {
  return (
    <span aria-hidden="true" className="relative inline-flex size-1.5 shrink-0">
      {pulse && <span className={`absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:hidden ${TONE_DOT[tone]}`} />}
      <span className={`relative inline-flex size-1.5 rounded-full ${TONE_DOT[tone]}`} />
    </span>
  );
}

function StatusBadge({ status }: { status: IndexingStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground">
      <StatusDot tone={INDEXING_STATUS_TONES[status]} />
      {INDEXING_STATUS_LABELS[status]}
    </span>
  );
}

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

  const tone = activityTone(health, delayed);

  return (
    <div aria-label="Indexed activity" className="relative inline-flex">
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
        <summary className="flex min-h-10 cursor-pointer list-none flex-wrap items-center gap-x-2.5 gap-y-1 rounded-full border border-white/[0.08] bg-white/[0.03] px-3.5 py-1.5 text-[11px] font-[510] text-muted-foreground backdrop-blur-sm transition-colors hover:border-white/[0.14] hover:bg-white/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-open:border-white/[0.14] group-open:bg-white/[0.05] motion-reduce:transition-none [&::-webkit-details-marker]:hidden">
          <StatusDot tone={tone} pulse={tone === 'ok' || tone === 'busy'} />
          <span className="uppercase tracking-[0.12em]">Indexed activity</span>
          <span aria-hidden="true" className="h-3 w-px bg-white/[0.1]" />
          {stats ? (
            <span className="inline-flex items-center gap-1.5">
              <span key={`tx-${pulseKey}`} className="font-mono tabular-nums text-foreground karma-live-flash motion-reduce:animate-none">{stats.totalTransactions.toLocaleString('en-US')}</span>
              <span>receipts</span>
              <span aria-hidden="true" className="text-white/20">·</span>
              <span className="font-mono tabular-nums text-foreground">{stats.totalAgents.toLocaleString('en-US')}</span>
              <span>agents</span>
            </span>
          ) : <span>{statsFailed ? 'Counts unavailable' : 'Loading counts…'}</span>}
          <span aria-hidden="true" className="h-3 w-px bg-white/[0.1]" />
          <span role="status" className={delayed ? 'text-amber-300' : undefined}>{status}</span>
          <ChevronDown aria-hidden="true" className="size-3 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
        </summary>
        <div className="absolute left-0 top-full z-40 mt-2 max-h-[70vh] w-[min(26rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-border bg-popover text-xs text-popover-foreground shadow-2xl shadow-black/40">
          <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <p className="text-[13px] font-medium">Network coverage</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">Agent activity indexed across live networks.</p>
            </div>
            <span className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
              <StatusDot tone={tone} />
              {status}
            </span>
          </div>
          {healthFailed && <p className="border-b border-border bg-amber-400/[0.06] px-4 py-2 text-[11px] text-amber-200/90">Status updates are delayed. Showing the last available report.</p>}
          {health ? (
            <div className="divide-y divide-border">
              {activeActivityChains(health.chains).map((chain) => (
                <section key={chain.chain} aria-label={`${CHAIN_LABELS[chain.chain]} indexing`} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-[12px] font-medium">{CHAIN_LABELS[chain.chain]}</h3>
                    <StatusBadge status={chain.status} />
                  </div>
                  <ul className="mt-2 space-y-1.5">
                    {chain.paths.map((path) => (
                      <li key={path.path} className="rounded-md bg-white/[0.02] px-2.5 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-foreground/90">{path.label}</span>
                          <StatusBadge status={path.status} />
                        </div>
                        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-[11px] text-muted-foreground">
                          <dt>Last checked</dt>
                          <dd className="text-right tabular-nums"><CheckedTime value={path.lastCheckedAt} empty="Never checked" /></dd>
                          <dt>Last complete scan</dt>
                          <dd className="text-right tabular-nums"><CheckedTime value={path.lastSuccessAt} empty="Not yet completed" /></dd>
                        </dl>
                        {path.unresolved > 0 && <p className="mt-1 text-[11px] text-amber-200/80">At least {path.unresolved.toLocaleString('en-US')} coverage issues</p>}
                        {path.issue && <p className="mt-1 text-[11px] text-muted-foreground">{INDEXING_ISSUE_MESSAGES[path.issue]}</p>}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : <p className="px-4 py-4 text-muted-foreground">{healthFailed ? 'Network status is unavailable. Retrying automatically.' : 'Checking network status…'}</p>}
          <div className="flex items-end justify-between gap-3 border-t border-border px-4 py-3 text-[11px] text-muted-foreground">
            <div className="space-y-0.5">
              <p>Receipts checked: <CheckedTime value={stats?.freshness?.transactionsUpdatedAt} empty="Time unavailable" /></p>
              <p>Agents checked: <CheckedTime value={stats?.freshness?.agentsUpdatedAt} empty="Time unavailable" /></p>
              {delayed && <p className="pt-1 text-amber-200/90">Updates delayed. Existing counts are preserved; checks retry automatically.</p>}
            </div>
            <button type="button" onClick={() => setRefresh((value) => value + 1)} className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-foreground transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none">
              <RefreshCw aria-hidden="true" className="size-3" />
              Check again
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}
