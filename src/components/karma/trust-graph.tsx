'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { TrustTier } from '@/db/schema';

interface Agent {
  address: string;
  displayName: string | null;
  score: number;
  trustTier: TrustTier;
  txCount: number;
  primaryFacilitator: string | null;
}

interface GraphResponse {
  facilitator: string | null;
  agents: Agent[];
}

interface RecentTx {
  wallet_address: string;
  tx_signature: string;
  amount: number;
  timestamp: string;
}

const TIER_FILL: Record<TrustTier, string> = {
  Unrated: '#3a3d42',
  Poor: '#e5484d',
  Fair: '#f5a623',
  Good: '#828fff',
  'Very Good': '#10b981',
  Excellent: '#7170ff',
};

const TIER_LEGEND: { tier: TrustTier; label: string }[] = [
  { tier: 'Excellent', label: 'Excellent' },
  { tier: 'Very Good', label: 'Very Good' },
  { tier: 'Good', label: 'Good' },
  { tier: 'Fair', label: 'Fair' },
  { tier: 'Poor', label: 'Poor' },
];

const W = 960;
const H = 380;
const CX = W / 2;
const CY = H / 2;

function layout(agents: Agent[]) {
  const n = agents.length;
  if (n === 0) return [];
  // Two concentric rings when many agents, one when few
  const outerRadius = 160;
  const innerRadius = 100;
  const useTwo = n > 10;
  return agents.map((a, i) => {
    const ring = useTwo ? i % 2 : 0;
    const ringCount = useTwo ? Math.ceil(n / 2) : n;
    const ringIndex = useTwo ? Math.floor(i / 2) : i;
    const r = ring === 0 ? outerRadius : innerRadius;
    const angle = (ringIndex / ringCount) * Math.PI * 2 - Math.PI / 2;
    return {
      agent: a,
      x: CX + Math.cos(angle) * r,
      y: CY + Math.sin(angle) * r,
      r: 5 + Math.min(14, a.score / 8),
    };
  });
}

function shortAddr(a: string) {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

export function TrustGraph() {
  const router = useRouter();
  const [data, setData] = useState<GraphResponse | null>(null);
  const [recent, setRecent] = useState<RecentTx[]>([]);
  const [pulses, setPulses] = useState<{ address: string; id: number }[]>([]);
  const seenSigs = useRef<Set<string>>(new Set());
  const pulseIdRef = useRef(0);
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/graph')
      .then((r) => r.json())
      .then((d: GraphResponse) => !cancelled && setData(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch('/api/explore?limit=10', { cache: 'no-store' });
        if (!res.ok) return;
        const d = await res.json();
        const txs = (d.transactions ?? []) as RecentTx[];
        if (cancelled) return;

        const fresh: RecentTx[] = [];
        for (const tx of txs) {
          if (!seenSigs.current.has(tx.tx_signature)) {
            fresh.push(tx);
            seenSigs.current.add(tx.tx_signature);
          }
        }
        // On first load, seed without pulses
        if (recent.length === 0 && fresh.length === txs.length) {
          setRecent(txs);
          return;
        }
        if (fresh.length > 0) {
          setRecent((prev) => [...fresh, ...prev].slice(0, 20));
          setPulses((prev) => [
            ...prev,
            ...fresh.map((f) => ({
              address: f.wallet_address,
              id: ++pulseIdRef.current,
            })),
          ]);
          // Clean up pulses after animation
          fresh.forEach((f, idx) => {
            const id = pulseIdRef.current - fresh.length + idx + 1;
            setTimeout(() => {
              setPulses((p) => p.filter((x) => x.id !== id));
            }, 2200);
          });
        }
      } catch {}
    }

    poll();
    const interval = setInterval(poll, 8000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [recent.length]);

  const positioned = useMemo(
    () => (data?.agents ? layout(data.agents) : []),
    [data],
  );

  const positionMap = useMemo(() => {
    const m = new Map<string, { x: number; y: number; r: number }>();
    for (const p of positioned) m.set(p.agent.address, p);
    return m;
  }, [positioned]);

  if (!data) {
    return <div className="h-[420px]" />;
  }

  if (data.agents.length === 0) return null;

  const hoveredAgent = hovered
    ? data.agents.find((a) => a.address === hovered)
    : null;

  return (
    <section aria-label="Trust Network">
      <div className="relative">
        <div className="mb-1 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#10b981] opacity-60" />
              <span className="relative inline-flex size-1.5 rounded-full bg-[#10b981]" />
            </span>
            <span className="text-[11px] font-[510] uppercase tracking-[0.12em] text-[#8a8f98]">
              Live trust network
            </span>
          </div>
          <span className="font-mono text-[10px] tabular-nums text-[#62666d]">
            {data.agents.length} agents · {recent.length} pulses
          </span>
        </div>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-[420px] w-full"
          preserveAspectRatio="xMidYMid meet"
        >
          <defs>
            <radialGradient id="hubGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#7170ff" stopOpacity="0.45" />
              <stop offset="70%" stopColor="#5e6ad2" stopOpacity="0.08" />
              <stop offset="100%" stopColor="#5e6ad2" stopOpacity="0" />
            </radialGradient>
            <filter id="nodeGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Ambient hub glow */}
          <circle cx={CX} cy={CY} r={180} fill="url(#hubGlow)" />

          {/* Edges */}
          {positioned.map((p) => {
            const isPulsing = pulses.some((x) => x.address === p.agent.address);
            const isHovered = hovered === p.agent.address;
            return (
              <line
                key={`edge-${p.agent.address}`}
                x1={CX}
                y1={CY}
                x2={p.x}
                y2={p.y}
                stroke={
                  isPulsing || isHovered
                    ? TIER_FILL[p.agent.trustTier]
                    : 'rgb(255 255 255 / 0.08)'
                }
                strokeWidth={isPulsing ? 1.2 : isHovered ? 1 : 0.6}
                opacity={isPulsing ? 0.7 : isHovered ? 0.5 : 0.35}
                style={{ transition: 'all 400ms ease-out' }}
              />
            );
          })}

          {/* Traveling pulse dots */}
          {pulses.map((pulse) => {
            const pos = positionMap.get(pulse.address);
            if (!pos) return null;
            return (
              <circle
                key={pulse.id}
                r={3}
                fill={TIER_FILL[data.agents.find((a) => a.address === pulse.address)?.trustTier ?? 'Unrated']}
                filter="url(#nodeGlow)"
              >
                <animate
                  attributeName="cx"
                  from={pos.x}
                  to={CX}
                  dur="1.6s"
                  fill="freeze"
                />
                <animate
                  attributeName="cy"
                  from={pos.y}
                  to={CY}
                  dur="1.6s"
                  fill="freeze"
                />
                <animate
                  attributeName="opacity"
                  values="0;1;1;0"
                  keyTimes="0;0.15;0.85;1"
                  dur="1.6s"
                  fill="freeze"
                />
              </circle>
            );
          })}

          {/* Hub node */}
          <g>
            <circle
              cx={CX}
              cy={CY}
              r={26}
              fill="#0f1011"
              stroke="rgb(113 112 255 / 0.4)"
              strokeWidth={1}
            />
            <circle
              cx={CX}
              cy={CY}
              r={22}
              fill="rgb(94 106 210 / 0.1)"
              stroke="rgb(113 112 255 / 0.25)"
              strokeWidth={0.5}
            />
            <text
              x={CX}
              y={CY - 2}
              textAnchor="middle"
              className="fill-[#d0d6e0] text-[10px] font-[600] uppercase tracking-[0.08em]"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              x402
            </text>
            <text
              x={CX}
              y={CY + 10}
              textAnchor="middle"
              className="fill-[#62666d] text-[8px] font-[510] uppercase tracking-[0.12em]"
            >
              facilitator
            </text>
          </g>

          {/* Agent nodes */}
          {positioned.map((p) => {
            const isPulsing = pulses.some((x) => x.address === p.agent.address);
            const isHovered = hovered === p.agent.address;
            return (
              <g
                key={p.agent.address}
                onMouseEnter={() => setHovered(p.agent.address)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => router.push(`/agent/${p.agent.address}`)}
                style={{ cursor: 'pointer' }}
              >
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={p.r + 8}
                  fill="transparent"
                />
                {(isPulsing || isHovered) && (
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={p.r + 6}
                    fill="none"
                    stroke={TIER_FILL[p.agent.trustTier]}
                    strokeWidth={0.5}
                    opacity={0.4}
                  >
                    {isPulsing && (
                      <animate
                        attributeName="r"
                        from={p.r}
                        to={p.r + 14}
                        dur="1.4s"
                        repeatCount="1"
                      />
                    )}
                    {isPulsing && (
                      <animate
                        attributeName="opacity"
                        from="0.6"
                        to="0"
                        dur="1.4s"
                        repeatCount="1"
                        fill="freeze"
                      />
                    )}
                  </circle>
                )}
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={p.r}
                  fill={TIER_FILL[p.agent.trustTier]}
                  fillOpacity={isHovered || isPulsing ? 1 : 0.85}
                  stroke="#08090a"
                  strokeWidth={1.2}
                  filter={isHovered || isPulsing ? 'url(#nodeGlow)' : undefined}
                  style={{ transition: 'fill-opacity 200ms' }}
                />
              </g>
            );
          })}
        </svg>

        {/* Hovered agent card */}
        {hoveredAgent && (
          <div className="pointer-events-none absolute left-4 top-4 rounded-md border border-[rgb(255_255_255/0.08)] bg-[rgb(15_16_17/0.85)] px-3 py-2 text-[11px] backdrop-blur-sm">
            <p className="font-mono text-[#f7f8f8]">
              {hoveredAgent.displayName ?? shortAddr(hoveredAgent.address)}
            </p>
            <p className="mt-0.5 flex items-center gap-2 text-[#8a8f98]">
              <span
                className="inline-block size-1.5 rounded-full"
                style={{ background: TIER_FILL[hoveredAgent.trustTier] }}
              />
              {hoveredAgent.trustTier} · {hoveredAgent.score.toFixed(1)} ·{' '}
              {hoveredAgent.txCount.toLocaleString()} tx
            </p>
          </div>
        )}

        {/* Legend */}
        <div className="pointer-events-none absolute bottom-0 right-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[#62666d]">
          {TIER_LEGEND.map((l) => (
            <span key={l.tier} className="flex items-center gap-1.5">
              <span
                className="inline-block size-1.5 rounded-full"
                style={{ background: TIER_FILL[l.tier] }}
              />
              {l.label}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
