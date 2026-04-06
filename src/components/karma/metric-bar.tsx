import { cn } from '@/lib/utils';

export function MetricBar({
  label,
  value,
  maxLabel,
  weight,
}: {
  label: string;
  value: number;       // 0–1 normalized
  maxLabel?: string;
  weight?: string;
}) {
  const pct = Math.round(value * 100);

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {pct}%
          {weight && <span className="ml-1 opacity-60">({weight})</span>}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            pct >= 80 ? 'bg-emerald-500' :
            pct >= 50 ? 'bg-blue-500' :
            pct >= 25 ? 'bg-orange-400' :
            'bg-red-400'
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {maxLabel && (
        <p className="text-[10px] text-muted-foreground">{maxLabel}</p>
      )}
    </div>
  );
}
