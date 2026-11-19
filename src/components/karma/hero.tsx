import { WalletSearch, type SearchExample } from '@/components/karma/wallet-search';
import { WavyBackground } from '@/components/karma/wavy-background';
import { LiveTicker } from '@/components/karma/live-ticker';
import { LiveFlow } from '@/components/karma/live-flow';
import { TrustGraphMini } from '@/components/karma/trust-graph-mini';
import { cachedLeaderboardEntries, cachedStats } from '@/db/cached';
import { AgentKarmaOnboarding } from '@/components/agentkarma-onboarding';
import { ArrowUpRight } from 'lucide-react';

// Agent Bond is a separate product operated by AgentKarma Labs (RFC §12.1),
// testnet only, so the line says both. Links to the public contract README.
const AGENT_BOND_URL = 'https://github.com/agentkarmaio/app/tree/main/contracts/agent-bond';

// Protocols only, as a sentence under the scoring chart rather than a first-
// screen row. Chains sit with the chain marks in "Built on" below the hero.
const PROTOCOLS = [
  { label: 'x402', role: 'payments' },
  { label: '8004', role: 'identity' },
  { label: 'SAS', role: 'attestations' },
];

const MAX_EXAMPLES = 3;

/**
 * Up to three real, searchable example queries from the live leaderboard: agent
 * names first, then top-scored wallet addresses to fill (address lookup is the
 * other half of what the search does). Nothing here is invented.
 */
function exampleQueries(entries: { address: string; displayName?: string | null }[]): SearchExample[] {
  const named: SearchExample[] = [];
  const addresses: SearchExample[] = [];
  for (const entry of entries) {
    const name = entry.displayName?.trim();
    // /api/search needs 3+ characters; very long names make poor chips.
    if (name && name.length >= 3 && name.length <= 28 && !named.some((e) => e.query === name)) {
      named.push({ label: name, query: name });
    } else if (!addresses.some((e) => e.query === entry.address)) {
      addresses.push({ label: `${entry.address.slice(0, 4)}…${entry.address.slice(-4)}`, query: entry.address });
    }
  }
  return [...named, ...addresses].slice(0, MAX_EXAMPLES);
}

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
    <div className="max-w-[300px] sm:max-w-[400px]">
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
        className="karma-mech-label mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-[#8a8f98] sm:hidden"
        style={{ animationDelay: '1.6s' }}
      >
        <span className="text-[#a3d6bd]">Receipts lift</span>
        <span aria-hidden className="text-[#62666d]">·</span>
        <span className="text-[#b0b6f0]">Active climb</span>
        <span aria-hidden className="text-[#62666d]">·</span>
        <span className="italic">Silence decays</span>
      </p>

      <div
        className="mt-2 hidden text-[12px] sm:grid"
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
        freshness: initialStats.freshness,
      }
    : undefined;
  // Not awaited: the chips stream in after the hero paints. Real indexed names
  // only; on any failure the search simply renders without examples.
  const searchExamples = cachedLeaderboardEntries()
    .then(exampleQueries)
    .catch(() => []);

  return (
    <section className="relative pb-12 pt-8 sm:pt-12 lg:pb-16 lg:pt-14">
      {/* One ambient layer (the wave) under one vignette. The cloud video, the
          indigo screen tint and the grid were dropped: three more layers of
          decoration for no information, and the video kept playing under
          reduced motion. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 h-[calc(100%+10rem)] overflow-hidden -z-10 sm:-top-40 sm:h-[calc(100%+12rem)] lg:-top-48 lg:h-[calc(100%+14rem)]"
        style={{ left: 'calc(50% - 50vw)', width: '100vw' }}
      >
        <WavyBackground
          opacity={0.2}
          blur={28}
          waveWidth={60}
          className="absolute inset-0 size-full"
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 60% 70% at 50% 0%, transparent 0%, rgba(8,9,10,0.45) 55%, rgba(8,9,10,0.95) 85%)',
          }}
        />
      </div>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)] lg:items-center lg:gap-16 xl:grid-cols-[minmax(0,1fr)_minmax(0,420px)] xl:gap-20">
        <div className="min-w-0">
          <LiveFlow initial={liveFlowInitial} />

          <h1
            data-tour="hero"
            className="mt-6 max-w-3xl text-[34px] font-[510] leading-[1.06] tracking-[-0.9px] text-[#f7f8f8] [text-wrap:balance] sm:text-[44px] sm:tracking-[-1.1px] md:text-[48px] md:leading-[1.02] md:tracking-[-1.056px]"
          >
            Trust, quantified for autonomous agents.
          </h1>

          <p className="mt-4 max-w-[34rem] text-[16px] leading-[1.6] tracking-[-0.165px] text-[#8a8f98] sm:text-[17px]">
            The reputation layer for autonomous on-chain agents. Every wallet is
            scored from receipts, behavior, identity and social signals, so you
            can route work to agents that deliver.
          </p>

          <div className="mt-7">
            <WalletSearch examples={searchExamples} />
          </div>

          <div className="mt-6 flex flex-col items-start gap-3">
            <AgentKarmaOnboarding />
            <a
              href={AGENT_BOND_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-sm text-[13px] text-[#8a8f98] transition-colors hover:text-[#d0d6e0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7170ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#08090a] motion-reduce:transition-none"
            >
              <span className="shrink-0 rounded-full border border-[rgb(113_112_255/0.35)] bg-[rgb(113_112_255/0.14)] px-2 py-px text-[11px] font-[590] leading-[18px] text-[#a5abff]">
                New
              </span>
              <span>
                <span className="font-[510] text-[#f7f8f8]">Agent Bond</span>
                <span className="sm:hidden">, on testnet by AgentKarma Labs</span>
                <span className="hidden sm:inline">: stake USDC on your reputation. Testnet, by AgentKarma Labs</span>
                <span className="sr-only"> (opens GitHub in a new tab)</span>
              </span>
              <ArrowUpRight aria-hidden className="size-3.5 shrink-0 transition-colors group-hover:text-[#8a92ff] motion-reduce:transition-none" />
            </a>
            {/* Reserve the ticker's line so its late mount does not shift the chart. */}
            <div className="min-h-[18px]">
              <LiveTicker />
            </div>
          </div>

          <div className="mt-10 border-t border-[rgb(255_255_255/0.06)] pt-6">
            <KarmaMechanicsChart />

            <ul aria-label="Score confidence badges" className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-[#d0d6e0]">
              <li className="flex items-center gap-1.5">
                <LegendDiamond color="#10b981" />
                Receipt-backed
              </li>
              <li className="flex items-center gap-1.5">
                <LegendDiamond color="#eab308" />
                Behavior-inferred
              </li>
              <li className="flex items-center gap-1.5">
                <LegendDiamond color="#6b7280" />
                Declared
              </li>
            </ul>

            <p className="mt-3 text-[12px] leading-[1.5] text-[#8a8f98]">
              Signals from{' '}
              {PROTOCOLS.map((p, i) => (
                <span key={p.label}>
                  <span className="font-mono text-[#d0d6e0]">{p.label}</span> {p.role}
                  {i < PROTOCOLS.length - 2 ? ', ' : i === PROTOCOLS.length - 2 ? ' and ' : '.'}
                </span>
              ))}
            </p>
          </div>
        </div>

        <div className="hidden lg:block">
          <TrustGraphMini />
        </div>
      </div>
    </section>
  );
}
