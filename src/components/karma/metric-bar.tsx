import { cn } from '@/lib/utils';

export function MetricBar({
  label,
  value,
  maxLabel,
  weight,
}: {
  label: string;
  value: number;
  maxLabel?: string;
  weight?: string;
}) {
  const pct = Math.round(value * 100);

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-[510] text-[#d0d6e0]">{label}</span>
        <span className="text-xs font-[510] tabular-nums text-[#62666d]">
          {pct}%
          {weight && <span className="ml-1 opacity-50">({weight})</span>}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[rgb(255_255_255/0.05)]">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            pct >= 80 ? 'bg-[#10b981]' :
            pct >= 50 ? 'bg-[#5e6ad2]' :
            pct >= 25 ? 'bg-[#f5a623]' :
            'bg-[#e5484d]'
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {maxLabel && (
        <p className="text-[10px] text-[#62666d]">{maxLabel}</p>
      )}
    </div>
  );
}
