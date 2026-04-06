import { cn } from '@/lib/utils';
import type { TrustTier } from '@/db/schema';

const TIER_RING_COLOR: Record<TrustTier, string> = {
  Unrated: 'stroke-zinc-300 dark:stroke-zinc-600',
  Poor: 'stroke-red-400',
  Fair: 'stroke-orange-400',
  Good: 'stroke-blue-400',
  'Very Good': 'stroke-emerald-400',
  Excellent: 'stroke-violet-500',
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
          className="stroke-muted"
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
      <span className="absolute text-lg font-bold tabular-nums">
        {score.toFixed(0)}
      </span>
    </div>
  );
}
