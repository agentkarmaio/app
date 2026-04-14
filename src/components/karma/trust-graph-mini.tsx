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

const TOP_TIERS: TrustTier[] = ['Excellent', 'Very Good'];

const W = 420;
const H = 360;
const CX = W / 2;
const CY = H / 2;
const OUTER_R = 140;
const INNER_R = 92;
const MAX_NODES = 18;

function shortAddr(a: string) {
  return `${a.slice(0, 4)}\u2026${a.slice(-4)}`;
}

function hashAddr(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

interface Positioned {
  agent: Agent;
  x: number;
  y: number;
  r: number;
  ring: 0 | 1;
}

function layout(agents: Agent[]): Positioned[] {
  const list = [...agents]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_NODES);
  const n = list.length;
  if (n === 0) return [];

  const outer: Agent[] = [];
  const inner: Agent[] = [];
  list.forEach((a, i) => (i < Math.ceil(n / 2) ? outer : inner).push(a));

  const place = (arr: Agent[], radius: number, ring: 0 | 1, phase: number): Positioned[] =>
    arr.map((a, i) => {
      const base = (i / arr.length) * Math.PI * 2 + phase;
      const jitter = ((hashAddr(a.address) % 80) - 40) / 1000;
      const angle = base + jitter;
      return {
        agent: a,
        x: CX + Math.cos(angle) * radius,
        y: CY + Math.sin(angle) * radius,
        r: 3.5 + Math.min(5.5, a.score / 14),
        ring,
      };
    });

  return [
    ...place(outer, OUTER_R, 0, -Math.PI / 2),
    ...place(inner, INNER_R, 1, -Math.PI / 2 + Math.PI / inner.length),
  ];
}

export function TrustGraphMini() {
  const router = useRouter();
  const [data, setData] = useState<GraphResponse | null>(null);
  const [pulses, setPulses] = useState<{ address: string; id: number }[]>([]);
  const [ambient, setAmbient] = useState<{ address: string; id: number } | null>(null);
  const seenSigs = useRef<Set<string>>(new Set());
  const pulseIdRef = useRef(0);
  const seededRef = useRef(false);
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
        if (!seededRef.current) {
          seededRef.current = true;
          return;
        }
        if (fresh.length === 0) return;

        setPulses((prev) => [
          ...prev,
          ...fresh.map((f) => ({
            address: f.wallet_address,
            id: ++pulseIdRef.current,
          })),
        ]);
        fresh.forEach((_, idx) => {
          const id = pulseIdRef.current - fresh.length + idx + 1;
          setTimeout(() => {
            setPulses((p) => p.filter((x) => x.id !== id));
          }, 2200);
        });
      } catch {}
    }

    poll();
    const interval = setInterval(poll, 8000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!data || data.agents.length === 0) return;
    const addresses = data.agents.slice(0, MAX_NODES).map((a) => a.address);
    const interval = setInterval(() => {
      const pick = addresses[Math.floor(Math.random() * addresses.length)];
      const id = ++pulseIdRef.current;
      setAmbient({ address: pick, id });
      setTimeout(() => {
        setAmbient((cur) => (cur?.id === id ? null : cur));
      }, 1700);
    }, 2600);
    return () => clearInterval(interval);
  }, [data]);

  const positioned = useMemo(
    () => (data?.agents ? layout(data.agents) : []),
    [data],
  );

  const positionMap = useMemo(() => {
    const m = new Map<string, Positioned>();
    for (const p of positioned) m.set(p.agent.address, p);
    return m;
  }, [positioned]);

  const hoveredAgent = hovered
    ? data?.agents.find((a) => a.address === hovered) ?? null
    : null;

  if (!data || data.agents.length === 0) {
    return <div className="h-[360px] w-full" aria-hidden />;
  }

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-full w-full"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <radialGradient id="hubGlowMini" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#7170ff" stopOpacity="0.45" />
            <stop offset="45%" stopColor="#5e6ad2" stopOpacity="0.1" />
            <stop offset="100%" stopColor="#5e6ad2" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="hubCore" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#1a1d2e" />
            <stop offset="100%" stopColor="#0c0d14" />
          </radialGradient>
          <filter id="nodeGlowMini" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="2.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          {positioned.map((p) => (
            <linearGradient
              key={`g-${p.agent.address}`}
              id={`edge-${p.agent.address}`}
              x1={CX}
              y1={CY}
              x2={p.x}
              y2={p.y}
              gradientUnits="userSpaceOnUse"
            >
              <stop offset="0%" stopColor="#5e6ad2" stopOpacity="0.35" />
              <stop
                offset="100%"
                stopColor={TIER_FILL[p.agent.trustTier]}
                stopOpacity="0.5"
              />
            </linearGradient>
          ))}
        </defs>

        {/* Ambient hub glow */}
        <circle cx={CX} cy={CY} r={160} fill="url(#hubGlowMini)" />

        {/* Concentric orbit rings (subtle) */}
        <circle
          cx={CX}
          cy={CY}
          r={OUTER_R}
          fill="none"
          stroke="rgb(255 255 255 / 0.035)"
          strokeWidth={0.5}
          strokeDasharray="1 4"
        />
        <circle
          cx={CX}
          cy={CY}
          r={INNER_R}
          fill="none"
          stroke="rgb(255 255 255 / 0.04)"
          strokeWidth={0.5}
          strokeDasharray="1 4"
        />

        {/* Edges with gradient + pulse highlighting */}
        {positioned.map((p) => {
          const isPulsing = pulses.some((x) => x.address === p.agent.address);
          const isAmbient = ambient?.address === p.agent.address;
          const isHovered = hovered === p.agent.address;
          const active = isPulsing || isHovered || isAmbient;
          return (
            <line
              key={`edge-${p.agent.address}`}
              x1={CX}
              y1={CY}
              x2={p.x}
              y2={p.y}
              stroke={
                active
                  ? `url(#edge-${p.agent.address})`
                  : 'rgb(255 255 255 / 0.055)'
              }
              strokeWidth={isPulsing ? 1.1 : active ? 0.8 : 0.5}
              opacity={isPulsing ? 0.9 : isHovered ? 0.7 : isAmbient ? 0.55 : 0.35}
              style={{ transition: 'all 500ms ease-out' }}
            />
          );
        })}

        {/* Hub pulse ring (continuous heartbeat) */}
        <circle
          cx={CX}
          cy={CY}
          r={22}
          fill="none"
          stroke="rgb(113 112 255 / 0.4)"
          strokeWidth={0.8}
        >
          <animate
            attributeName="r"
            values="22;40;22"
            dur="3.6s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0.5;0;0.5"
            dur="3.6s"
            repeatCount="indefinite"
          />
        </circle>

        {/* Slow rotating dashed ring around hub */}
        <g transform={`rotate(0 ${CX} ${CY})`}>
          <circle
            cx={CX}
            cy={CY}
            r={28}
            fill="none"
            stroke="rgb(113 112 255 / 0.35)"
            strokeWidth={0.6}
            strokeDasharray="2 6"
          >
            <animateTransform
              attributeName="transform"
              type="rotate"
              from={`0 ${CX} ${CY}`}
              to={`360 ${CX} ${CY}`}
              dur="28s"
              repeatCount="indefinite"
            />
          </circle>
        </g>

        {/* Ambient / recent pulse dots traveling node → hub */}
        {pulses.map((pulse) => {
          const pos = positionMap.get(pulse.address);
          if (!pos) return null;
          const tier =
            data.agents.find((a) => a.address === pulse.address)?.trustTier ??
            'Unrated';
          return (
            <circle
              key={`p-${pulse.id}`}
              r={2.4}
              fill={TIER_FILL[tier]}
              filter="url(#nodeGlowMini)"
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

        {ambient && (() => {
          const pos = positionMap.get(ambient.address);
          if (!pos) return null;
          const tier =
            data.agents.find((a) => a.address === ambient.address)?.trustTier ??
            'Unrated';
          return (
            <circle
              key={`a-${ambient.id}`}
              r={1.8}
              fill={TIER_FILL[tier]}
              opacity={0.7}
            >
              <animate
                attributeName="cx"
                from={pos.x}
                to={CX}
                dur="1.7s"
                fill="freeze"
              />
              <animate
                attributeName="cy"
                from={pos.y}
                to={CY}
                dur="1.7s"
                fill="freeze"
              />
              <animate
                attributeName="opacity"
                values="0;0.7;0.7;0"
                keyTimes="0;0.2;0.8;1"
                dur="1.7s"
                fill="freeze"
              />
            </circle>
          );
        })()}

        {/* Hub core */}
        <g>
          <circle
            cx={CX}
            cy={CY}
            r={19}
            fill="url(#hubCore)"
            stroke="rgb(113 112 255 / 0.55)"
            strokeWidth={1}
          />
          <circle
            cx={CX}
            cy={CY}
            r={14.5}
            fill="rgb(94 106 210 / 0.12)"
            stroke="rgb(113 112 255 / 0.3)"
            strokeWidth={0.5}
          />
          <text
            x={CX}
            y={CY + 3}
            textAnchor="middle"
            className="fill-[#d0d6e0] text-[8.5px] font-[600] uppercase tracking-[0.1em]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            x402
          </text>
        </g>

        {/* Agent nodes */}
        {positioned.map((p) => {
          const isPulsing = pulses.some((x) => x.address === p.agent.address);
          const isHovered = hovered === p.agent.address;
          const isTop = TOP_TIERS.includes(p.agent.trustTier);
          return (
            <g
              key={p.agent.address}
              onMouseEnter={() => setHovered(p.agent.address)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => router.push(`/agent/${p.agent.address}`)}
              style={{ cursor: 'pointer' }}
            >
              <circle cx={p.x} cy={p.y} r={p.r + 8} fill="transparent" />

              {(isPulsing || isHovered) && (
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={p.r + 3}
                  fill="none"
                  stroke={TIER_FILL[p.agent.trustTier]}
                  strokeWidth={0.6}
                  opacity={0.45}
                >
                  {isPulsing && (
                    <>
                      <animate
                        attributeName="r"
                        from={p.r}
                        to={p.r + 12}
                        dur="1.4s"
                        repeatCount="1"
                      />
                      <animate
                        attributeName="opacity"
                        from="0.55"
                        to="0"
                        dur="1.4s"
                        repeatCount="1"
                        fill="freeze"
                      />
                    </>
                  )}
                </circle>
              )}

              <circle
                cx={p.x}
                cy={p.y}
                r={p.r}
                fill={TIER_FILL[p.agent.trustTier]}
                fillOpacity={isHovered || isPulsing ? 1 : isTop ? 0.92 : 0.78}
                stroke="#08090a"
                strokeWidth={0.9}
                filter={isTop || isHovered || isPulsing ? 'url(#nodeGlowMini)' : undefined}
                style={{ transition: 'fill-opacity 200ms, r 200ms' }}
              />
            </g>
          );
        })}
      </svg>

      {hoveredAgent && (
        <div className="pointer-events-none absolute left-2 top-2 rounded-lg border border-[rgb(255_255_255/0.08)] bg-[rgb(15_16_17/0.88)] px-2.5 py-1.5 text-[10.5px] backdrop-blur-sm shadow-[0_4px_12px_-4px_rgb(0_0_0/0.8)]">
          <p className="font-mono text-[#f7f8f8]">
            {hoveredAgent.displayName ?? shortAddr(hoveredAgent.address)}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 text-[#8a8f98]">
            <span
              className="inline-block size-1.5 rounded-full"
              style={{ background: TIER_FILL[hoveredAgent.trustTier] }}
            />
            {hoveredAgent.trustTier} · {hoveredAgent.score.toFixed(1)}
          </p>
        </div>
      )}

      <div className="pointer-events-none absolute bottom-1 right-1 font-mono text-[9px] tabular-nums text-[#4f5258]">
        {data.agents.length} agents
      </div>
    </div>
  );
}
