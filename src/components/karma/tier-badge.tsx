import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { TrustTier } from '@/db/schema';

const TIER_CONFIG: Record<TrustTier, { label: string; className: string }> = {
  Unrated: {
    label: 'Unrated',
    className: 'bg-zinc-100 text-zinc-500 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700',
  },
  Poor: {
    label: 'Poor',
    className: 'bg-red-50 text-red-600 border-red-200 dark:bg-red-950 dark:text-red-400 dark:border-red-800',
  },
  Fair: {
    label: 'Fair',
    className: 'bg-orange-50 text-orange-600 border-orange-200 dark:bg-orange-950 dark:text-orange-400 dark:border-orange-800',
  },
  Good: {
    label: 'Good',
    className: 'bg-blue-50 text-blue-600 border-blue-200 dark:bg-blue-950 dark:text-blue-400 dark:border-blue-800',
  },
  'Very Good': {
    label: 'Very Good',
    className: 'bg-emerald-50 text-emerald-600 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-400 dark:border-emerald-800',
  },
  Excellent: {
    label: 'Excellent',
    className: 'bg-violet-50 text-violet-600 border-violet-200 dark:bg-violet-950 dark:text-violet-400 dark:border-violet-800',
  },
};

export function TierBadge({
  tier,
  size = 'default',
  className,
}: {
  tier: TrustTier;
  size?: 'sm' | 'default';
  className?: string;
}) {
  const config = TIER_CONFIG[tier] ?? TIER_CONFIG.Unrated;

  return (
    <Badge
      variant="outline"
      className={cn(
        'font-medium',
        size === 'sm' && 'text-[10px] px-1.5 py-0',
        config.className,
        className,
      )}
    >
      {config.label}
    </Badge>
  );
}
