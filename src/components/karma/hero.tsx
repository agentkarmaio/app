import { WalletSearch } from '@/components/karma/wallet-search';
import { WavyBackground } from '@/components/karma/wavy-background';
import { LiveTicker } from '@/components/karma/live-ticker';
import { LiveFlow } from '@/components/karma/live-flow';
import { TrustGraphMini } from '@/components/karma/trust-graph-mini';
import { cachedStats } from '@/db/cached';

const PROTOCOLS = [
  { label: 'x402', role: 'payments' },
  { label: '8004', role: 'identity' },
  { label: 'SAS', role: 'attestation' },
  { label: 'Solana · Celo', role: 'settlement' },
];

function LegendDiamond({ color }: { color: string }) {
  return (
    <svg aria-hidden viewBox="0 0 10 10" className="size-2 shrink-0">
      <path
        d="M5 0.8 L9.2 5 L5 9.2 L0.8 5 Z"
        fill={color}
        stroke="#08090a"
        strokeWidth="0.5"
        strokeLinejoin="miter"
      />
      <path d="M5 0.8 L5 5 L0.8 5 Z" fill="#ffffff" fillOpacity="0.22" />
      <path d="M9.2 5 L5 9.2 L5 5 Z" fill="#000000" fillOpacity="0.22" />
    </svg>
  );
}

function KarmaMechanicsChart() {
  const linePath =
    'M 4 32 C 14 32 24 30 34 24 C 44 14 54 8 64 8 C 78 8 86 11 98 15 C 126 12 156 8 200 5 C 222 6 242 14 276 28';
  const fillPath = `${linePath} L 276 34 L 4 34 Z`;

  const markers = [
    { x: 64, y: 8, color: '#10b981', delay: '1.45s' },
    { x: 200, y: 5, color: '#8a92ff', delay: '1.75s' },
    { x: 276, y: 28, color: '#6b7280', delay: '2.05s' },
  ];

  return (
    <div className="mt-3 max-w-[260px] sm:max-w-[380px]">
      <svg
        aria-hidden
        viewBox="0 0 280 38"
        className="block w-full overflow-visible"
        style={{ height: 'auto' }}
      >
        <defs>
          <linearGradient id="karmaMechLine" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#10b981" />
            <stop offset="46%" stopColor="#8a92ff" />
            <stop offset="78%" stopColor="#7170ff" />
            <stop offset="100%" stopColor="#4f5258" />
          </linearGradient>
          <linearGradient id="karmaMechFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7170ff" stopOpacity="0.14" />
            <stop offset="60%" stopColor="#7170ff" stopOpacity="0.04" />
            <stop offset="100%" stopColor="#7170ff" stopOpacity="0" />
          </linearGradient>
          <filter
            id="karmaMechGlow"
            x="-200%"
            y="-200%"
            width="500%"
            height="500%"
          >
            <feGaussianBlur stdDeviation="2" />
          </filter>
        </defs>

        <path d={fillPath} fill="url(#karmaMechFill)" className="karma-mech-fill" />

        <path
          d={linePath}
          fill="none"
          stroke="url(#karmaMechLine)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="karma-mech-line"
        />

        {markers.map((m) => (
          <g
            key={`${m.x}-${m.y}`}
            className="karma-mech-marker"
            style={{ animationDelay: m.delay }}
          >
            <circle
              cx={m.x}
              cy={m.y}
              r="4"
              fill={m.color}
              opacity="0.32"
              filter="url(#karmaMechGlow)"
              className="karma-mech-pulse"
            />
            <circle
              cx={m.x}
              cy={m.y}
              r="2.2"
              fill={m.color}
              stroke="rgba(255,255,255,0.92)"
              strokeWidth="0.55"
            />
          </g>
        ))}
      </svg>

      <p
        className="karma-mech-label mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[10px] tracking-[-0.05px] text-[#8a8f98] sm:hidden"
        style={{ animationDelay: '1.6s' }}
      >
        <span className="text-[#a3d6bd]">Receipts lift</span>
        <span aria-hidden className="text-[#3f4248]">·</span>
        <span className="text-[#b0b6f0]">Active climb</span>
        <span aria-hidden className="text-[#3f4248]">·</span>
        <span className="italic">Silence decays</span>
      </p>

      <div
        className="mt-2 hidden text-[11px] tracking-[-0.08px] sm:grid"
        style={{ gridTemplateColumns: '30% 44% 26%' }}
      >
        <span
          className="karma-mech-label text-[#a3d6bd]"
          style={{ animationDelay: '1.5s' }}
        >
          Receipts lift
        </span>
        <span
          className="karma-mech-label text-center text-[#b0b6f0]"
          style={{ animationDelay: '1.8s' }}
        >
          Active agents climb
        </span>
        <span
          className="karma-mech-label text-right italic text-[#8a8f98]"
          style={{ animationDelay: '2.1s' }}
        >
          Silence decays
        </span>
      </div>
    </div>
  );
}

export async function Hero() {
  const initialStats = await cachedStats().catch(() => null);
  const liveFlowInitial = initialStats
    ? {
        totalAgents: initialStats.totalAgents,
        totalTransactions: initialStats.totalTransactions,
      }
    : undefined;

  return (
    <section className="relative pb-12 pt-10 sm:pt-16 lg:pb-20 lg:pt-20">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 h-[calc(100%+10rem)] overflow-hidden -z-10 sm:-top-40 sm:h-[calc(100%+12rem)] lg:-top-48 lg:h-[calc(100%+14rem)]"
        style={{ left: 'calc(50% - 50vw)', width: '100vw' }}
      >
        <div
          className="absolute inset-x-0 top-0 h-full overflow-hidden"
          style={{
            opacity: 0.16,
            filter: 'saturate(0.35) contrast(1.05) hue-rotate(200deg) brightness(0.9)',
            maskImage:
              'linear-gradient(to bottom, black 0%, black 30%, rgba(0,0,0,0.6) 55%, rgba(0,0,0,0.25) 75%, transparent 95%)',
            WebkitMaskImage:
              'linear-gradient(to bottom, black 0%, black 30%, rgba(0,0,0,0.6) 55%, rgba(0,0,0,0.25) 75%, transparent 95%)',
          }}
        >
          <video
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            className="size-full object-cover"
          >
            <source src="/backgrounds/win98-clouds.webm" type="video/webm" />
            <source src="/backgrounds/win98-clouds.mp4" type="video/mp4" />
          </video>
        </div>
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(180deg, rgba(94,106,210,0.08) 0%, rgba(94,106,210,0.03) 40%, transparent 70%)',
            mixBlendMode: 'screen',
          }}
        />
        <WavyBackground
          opacity={0.22}
          blur={28}
          waveWidth={60}
          className="absolute inset-0 size-full"
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 60% 70% at 50% 0%, transparent 0%, rgba(8,9,10,0.4) 55%, rgba(8,9,10,0.95) 85%)',
          }}
        />
        <div
          className="absolute inset-x-0 top-0 h-[420px] opacity-[0.14]"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(to right, rgba(255,255,255,0.05) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
            maskImage:
              'radial-gradient(ellipse 50% 70% at 50% 0%, black 30%, transparent 80%)',
            WebkitMaskImage:
              'radial-gradient(ellipse 50% 70% at 50% 0%, black 30%, transparent 80%)',
          }}
        />
      </div>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)] lg:items-center lg:gap-16 xl:grid-cols-[minmax(0,1fr)_minmax(0,420px)] xl:gap-20">
        <div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <LiveFlow initial={liveFlowInitial} />
          </div>

          <h1
            data-tour="hero"
            className="mt-5 max-w-3xl text-[32px] font-[560] leading-[1.08] tracking-[-1px] text-[#f7f8f8] sm:text-[40px] sm:leading-[1.05] sm:tracking-[-1.3px] md:text-[48px]"
          >
            Trust,{' '}
            <span className="bg-gradient-to-br from-[#8a92ff] via-[#7170ff] to-[#5e6ad2] bg-clip-text text-transparent">
              quantified
            </span>{' '}
            for autonomous agents.
          </h1>

          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-[#8a8f98] tracking-[-0.176px]">
            The reputation primitive for the agent economy. AgentKarma scores
            every on-chain wallet across four signal tiers — receipts, behavior,
            identity, and social — so builders, marketplaces, and enterprises can
            route work to agents that actually deliver.
          </p>

          <KarmaMechanicsChart />


          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-[#8a8f98]">
            <span className="flex items-center gap-1.5">
              <LegendDiamond color="#10b981" />
              <span className="text-[#d0d6e0]">Receipt-backed</span>
            </span>
            <span aria-hidden className="size-[2px] rounded-full bg-[rgb(255_255_255/0.12)]" />
            <span className="flex items-center gap-1.5">
              <LegendDiamond color="#eab308" />
              <span className="text-[#d0d6e0]">Behavior-inferred</span>
            </span>
            <span aria-hidden className="size-[2px] rounded-full bg-[rgb(255_255_255/0.12)]" />
            <span className="flex items-center gap-1.5">
              <LegendDiamond color="#6b7280" />
              <span className="text-[#d0d6e0]">Declared</span>
            </span>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[10px]">
            {PROTOCOLS.map((p, i) => (
              <span key={p.label} className="flex items-center gap-2">
                <span className="font-mono font-[500] text-[#8a8f98]">{p.label}</span>
                <span className="uppercase tracking-[0.14em] text-[#4f5258]">
                  {p.role}
                </span>
                {i < PROTOCOLS.length - 1 && (
                  <span
                    aria-hidden
                    className="size-[2px] rounded-full bg-[rgb(255_255_255/0.12)]"
                  />
                )}
              </span>
            ))}
          </div>

          <div className="mt-7 space-y-3">
            <div className="w-full max-w-md">
              <WalletSearch />
            </div>
            <div className="pl-4">
              <LiveTicker />
            </div>
          </div>
        </div>

        <div className="hidden lg:block">
          <TrustGraphMini />
        </div>
      </div>
    </section>
  );
}
