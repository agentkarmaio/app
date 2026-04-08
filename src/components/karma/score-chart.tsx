import type { TrustTier } from '@/db/schema';

interface DataPoint {
  score: number;
  calculated_at: string;
}

const TIER_COLORS: Record<TrustTier, string> = {
  Unrated: '#62666d',
  Poor: '#e5484d',
  Fair: '#f5a623',
  Good: '#5e6ad2',
  'Very Good': '#10b981',
  Excellent: '#7170ff',
};

export function ScoreChart({
  data,
  tier,
  width = 480,
  height = 140,
}: {
  data: DataPoint[];
  tier: TrustTier;
  width?: number;
  height?: number;
}) {
  if (data.length < 2) {
    return (
      <div className="flex items-center justify-center py-8 text-[13px] text-[#62666d]">
        Not enough data for trend chart. Scores will appear after multiple indexer runs.
      </div>
    );
  }

  const color = TIER_COLORS[tier] ?? '#5e6ad2';

  // Chart dimensions with padding
  const padLeft = 36;
  const padRight = 12;
  const padTop = 12;
  const padBottom = 24;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  // Data bounds
  const scores = data.map((d) => d.score);
  const minScore = Math.max(0, Math.floor(Math.min(...scores) / 10) * 10 - 5);
  const maxScore = Math.min(100, Math.ceil(Math.max(...scores) / 10) * 10 + 5);
  const scoreRange = maxScore - minScore || 1;

  // Map data to SVG coordinates
  const points = data.map((d, i) => ({
    x: padLeft + (i / (data.length - 1)) * chartW,
    y: padTop + chartH - ((d.score - minScore) / scoreRange) * chartH,
    score: d.score,
    date: d.calculated_at,
  }));

  // Build polyline path
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  // Build gradient fill path (line + bottom closing)
  const fillPath = linePath
    + ` L${points[points.length - 1].x.toFixed(1)},${padTop + chartH}`
    + ` L${points[0].x.toFixed(1)},${padTop + chartH} Z`;

  // Y-axis labels (3 ticks)
  const yTicks = [minScore, minScore + scoreRange / 2, maxScore];

  // X-axis labels (first, middle, last)
  const xLabels = [data[0], data[Math.floor(data.length / 2)], data[data.length - 1]];
  const xPositions = [padLeft, padLeft + chartW / 2, padLeft + chartW];

  const gradientId = `karma-gradient-${tier}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      style={{ maxHeight: height }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.15" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Grid lines */}
      {yTicks.map((tick, i) => {
        const y = padTop + chartH - ((tick - minScore) / scoreRange) * chartH;
        return (
          <g key={i}>
            <line
              x1={padLeft} y1={y} x2={padLeft + chartW} y2={y}
              stroke="white" strokeOpacity="0.04" strokeWidth="1"
            />
            <text
              x={padLeft - 6} y={y + 3.5}
              textAnchor="end"
              fill="#62666d" fontSize="10" fontFamily="Inter, sans-serif"
            >
              {Math.round(tick)}
            </text>
          </g>
        );
      })}

      {/* X-axis labels */}
      {xLabels.map((d, i) => (
        <text
          key={i}
          x={xPositions[i]}
          y={height - 4}
          textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}
          fill="#62666d" fontSize="10" fontFamily="Inter, sans-serif"
        >
          {formatDate(d.calculated_at)}
        </text>
      ))}

      {/* Gradient fill */}
      <path d={fillPath} fill={`url(#${gradientId})`} />

      {/* Line */}
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* End dot */}
      <circle
        cx={points[points.length - 1].x}
        cy={points[points.length - 1].y}
        r="3.5"
        fill={color}
        stroke="#111113"
        strokeWidth="2"
      />
    </svg>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
