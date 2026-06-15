/* SuccessionTimelineChart — fresh animated SVG for the Dead Man's Switch
 * lifecycle. Pure CSS animation (draw-on + node pulse), so it stays a server
 * component. Achromatic Linear language: indigo accent only, no spot art.
 *
 * Lifecycle, left to right:
 *   will_declared (T3, ⚪)  →  heartbeat_observed (T2, 🟡)
 *   →  heartbeat_lapsed (T2, 🟡)  →  inheritance_executed (heir acts)
 *
 * The custody seam — "AK witnesses, never holds" — is the spine label.
 */

const NODES = [
  {
    x: 60,
    label: 'will_declared',
    tier: 'Tier 3',
    color: '#8a8f98', // declared / ⚪
    delay: '0s',
  },
  {
    x: 200,
    label: 'heartbeat_observed',
    tier: 'Tier 2',
    color: '#f5a623', // behavior-inferred / 🟡
    delay: '0.6s',
  },
  {
    x: 340,
    label: 'heartbeat_lapsed',
    tier: 'Tier 2',
    color: '#f5a623',
    delay: '1.2s',
  },
  {
    x: 480,
    label: 'inheritance_executed',
    tier: 'heir acts',
    color: '#7170ff', // indigo — the only chromatic accent
    delay: '1.8s',
  },
] as const;

export function SuccessionTimelineChart({
  className,
}: {
  className?: string;
}) {
  return (
    <div className={className}>
      <svg
        viewBox="0 0 540 160"
        role="img"
        aria-label="Agent succession lifecycle: will declared, heartbeat observed, heartbeat lapsed, inheritance executed by the heir. AgentKarma witnesses each step on-chain and never holds funds."
        className="w-full"
      >
        <defs>
          <linearGradient id="ak-succession-line" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#8a8f98" stopOpacity="0.5" />
            <stop offset="55%" stopColor="#f5a623" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#7170ff" stopOpacity="0.7" />
          </linearGradient>
          <style>{`
            @keyframes ak-draw { to { stroke-dashoffset: 0; } }
            @keyframes ak-node-in {
              0% { opacity: 0; transform: scale(0.4); }
              100% { opacity: 1; transform: scale(1); }
            }
            @keyframes ak-pulse {
              0%, 100% { opacity: 0.25; }
              50% { opacity: 0.7; }
            }
            @media (prefers-reduced-motion: reduce) {
              .ak-line, .ak-node, .ak-ring { animation: none !important; }
              .ak-line { stroke-dashoffset: 0 !important; }
              .ak-node { opacity: 1 !important; }
            }
          `}</style>
        </defs>

        {/* connective line, drawn left to right */}
        <line
          className="ak-line"
          x1="60"
          y1="64"
          x2="480"
          y2="64"
          stroke="url(#ak-succession-line)"
          strokeWidth="1.5"
          strokeDasharray="420"
          strokeDashoffset="420"
          style={{ animation: 'ak-draw 2.2s ease-out forwards' }}
        />

        {NODES.map((n) => (
          <g
            key={n.label}
            className="ak-node"
            style={{
              transformOrigin: `${n.x}px 64px`,
              opacity: 0,
              animation: `ak-node-in 0.5s ease-out ${n.delay} forwards`,
            }}
          >
            {/* pulse ring */}
            <circle
              className="ak-ring"
              cx={n.x}
              cy="64"
              r="11"
              fill="none"
              stroke={n.color}
              strokeWidth="1"
              style={{ animation: `ak-pulse 2.4s ease-in-out ${n.delay} infinite` }}
            />
            {/* diamond node — echoes the ConfidenceBadge DiamondDot */}
            <path
              d={`M ${n.x} 57 L ${n.x + 6} 64 L ${n.x} 71 L ${n.x - 6} 64 Z`}
              fill={n.color}
              stroke="#08090a"
              strokeWidth="0.8"
            />
            <text
              x={n.x}
              y="92"
              textAnchor="middle"
              className="font-mono"
              fontSize="9"
              fill="#d0d6e0"
            >
              {n.label}
            </text>
            <text
              x={n.x}
              y="106"
              textAnchor="middle"
              fontSize="8"
              fill="#62666d"
              style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}
            >
              {n.tier}
            </text>
          </g>
        ))}

        {/* custody seam label — the composition's spine, not a footnote */}
        <text
          x="270"
          y="146"
          textAnchor="middle"
          fontSize="9.5"
          fill="#4f5258"
          style={{ letterSpacing: '0.14em', textTransform: 'uppercase' }}
        >
          AgentKarma witnesses · never holds
        </text>
      </svg>
    </div>
  );
}
