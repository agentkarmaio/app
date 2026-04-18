import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ConfidenceBadge as ConfidenceBadgeValue } from '@/db/schema';

const CONFIG: Record<ConfidenceBadgeValue, {
  dot: string;
  label: string;
  tooltip: string;
  className: string;
}> = {
  'receipt-backed': {
    dot: '🟢',
    label: 'Receipt-backed',
    tooltip: 'Tier 1 signals present — score is anchored to payment receipts and signed delivery feedback.',
    className: 'bg-[rgb(16_185_129/0.12)] text-[#10b981] border-[rgb(16_185_129/0.2)]',
  },
  'behavior-inferred': {
    dot: '🟡',
    label: 'Behavior-inferred',
    tooltip: 'No receipt-gated attestations yet — score is derived from on-chain behavior and declared identity.',
    className: 'bg-[rgb(245_166_35/0.12)] text-[#f5a623] border-[rgb(245_166_35/0.22)]',
  },
  declared: {
    dot: '⚪',
    label: 'Declared',
    tooltip: 'Only self-declared or derivative signals — low trust until receipts or behavior accrue.',
    className: 'bg-[rgb(255_255_255/0.04)] text-[#8a8f98] border-[rgb(255_255_255/0.08)]',
  },
};

export function ConfidenceBadge({
  badge,
  size = 'default',
  withDot = true,
  className: extraClass,
}: {
  badge: ConfidenceBadgeValue;
  size?: 'sm' | 'default';
  withDot?: boolean;
  className?: string;
}) {
  const config = CONFIG[badge] ?? CONFIG.declared;
  return (
    <Badge
      variant="outline"
      title={config.tooltip}
      className={cn(
        'font-[510] tracking-[-0.13px] gap-1',
        size === 'sm' && 'text-[10px] px-1.5 py-0',
        config.className,
        extraClass,
      )}
    >
      {withDot && <span aria-hidden className="text-[9px] leading-none">{config.dot}</span>}
      {config.label}
    </Badge>
  );
}
