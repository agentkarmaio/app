import { cn } from '@/lib/utils';
import type { TrustTier } from '@/db/schema';

const TIER_RING_COLOR: Record<TrustTier, string> = {
  Unrated: 'stroke-[#62666d]',
  Poor: 'stroke-[#e5484d]',
  Fair: 'stroke-[#f5a623]',
  Good: 'stroke-[#5e6ad2]',
  'Very Good': 'stroke-[#10b981]',
  Excellent: 'stroke-[#7170ff]',
};

export function ScoreRing({
  score,
  tier,
  size = 80,
  strokeWidth = 6,
  className,
}: {
  score: number;
  tier: TrustTier;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.min(score, 100) / 100;
  const dashOffset = circumference * (1 - progress);
  const color = TIER_RING_COLOR[tier] ?? TIER_RING_COLOR.Unrated;

  return (
    <div className={cn('relative inline-flex items-center justify-center', className)}>
      <svg width={size} height={size} className="-rotate-90" role="img" aria-label={`Karma score: ${score}`}>
        <title>{`Score: ${score.toFixed(0)}`}</title>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          className="stroke-[rgb(255_255_255/0.05)]"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          className={cn('transition-all duration-700 ease-out', color)}
        />
      </svg>
      <span className="absolute text-lg font-[510] tabular-nums text-[#f7f8f8]">
        {score.toFixed(0)}
      </span>
    </div>
  );
}
