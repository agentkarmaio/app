import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { TrustTier } from '@/db/schema';

const TIER_CONFIG: Record<TrustTier, { label: string; className: string }> = {
  Unrated: {
    label: 'Unrated',
    className: 'bg-[rgb(255_255_255/0.04)] text-[#62666d] border-[rgb(255_255_255/0.08)]',
  },
  Poor: {
    label: 'Poor',
    className: 'bg-[rgb(229_72_77/0.12)] text-[#e5484d] border-[rgb(229_72_77/0.2)]',
  },
  Fair: {
    label: 'Fair',
    className: 'bg-[rgb(255_165_0/0.12)] text-[#f5a623] border-[rgb(255_165_0/0.2)]',
  },
  Good: {
    label: 'Good',
    className: 'bg-[rgb(94_106_210/0.12)] text-[#828fff] border-[rgb(94_106_210/0.2)]',
  },
  'Very Good': {
    label: 'Very Good',
    className: 'bg-[rgb(16_185_129/0.12)] text-[#10b981] border-[rgb(16_185_129/0.2)]',
  },
  Excellent: {
    label: 'Excellent',
    className: 'bg-[rgb(113_112_255/0.12)] text-[#7170ff] border-[rgb(113_112_255/0.2)]',
  },
};

export function TierBadge({
  tier,
  size = 'default',
  className: extraClass,
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
        'font-[510] tracking-[-0.13px]',
        size === 'sm' && 'text-[10px] px-1.5 py-0',
        config.className,
        extraClass,
      )}
    >
      {config.label}
    </Badge>
  );
}
