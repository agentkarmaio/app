import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LivenessStatus } from '@/db/schema';
import { getLivenessStatus } from '@/db/schema';
import { formatRelativePastLong } from '@/lib/succession-format';

const LIVENESS_CONFIG: Record<LivenessStatus, { label: string; dotClass: string; textClass: string }> = {
  Active: {
    label: 'Active',
    dotClass: 'bg-[#30a46c]',
    textClass: 'text-[#30a46c]',
  },
  Recent: {
    label: 'Recent',
    dotClass: 'bg-[#f5a623]',
    textClass: 'text-[#f5a623]',
  },
  Dormant: {
    label: 'Dormant',
    dotClass: 'bg-[#62666d]',
    textClass: 'text-[#62666d]',
  },
  Inactive: {
    label: 'Inactive',
    dotClass: 'bg-[#e5484d]',
    textClass: 'text-[#e5484d]',
  },
};

export function LivenessIndicator({
  lastSeen,
  status: statusOverride,
  size = 'default',
  showRelative = false,
  className,
}: {
  lastSeen?: string | Date;
  status?: LivenessStatus;
  size?: 'sm' | 'default';
  /** Append the precise "last active" time (e.g. "· 4h ago") after the status label. */
  showRelative?: boolean;
  className?: string;
}) {
  const status = statusOverride ?? (lastSeen ? getLivenessStatus(lastSeen) : 'Inactive');
  const config = LIVENESS_CONFIG[status];
  const relativeIso = lastSeen == null ? null : typeof lastSeen === 'string' ? lastSeen : lastSeen.toISOString();

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span
        className={cn(
          'rounded-full shrink-0',
          size === 'sm' ? 'size-1.5' : 'size-2',
          config.dotClass,
          status === 'Active' && 'animate-pulse',
        )}
      />
      <span
        className={cn(
          'font-[510] tracking-[-0.13px]',
          size === 'sm' ? 'text-[11px]' : 'text-[13px]',
          config.textClass,
        )}
      >
        {config.label}
      </span>
      {showRelative && relativeIso && (
        <span
          className={cn(
            'inline-flex items-center gap-1 text-muted-foreground tracking-[-0.13px]',
            size === 'sm' ? 'text-[11px]' : 'text-[13px]',
          )}
        >
          <Clock className={size === 'sm' ? 'size-3' : 'size-3.5'} aria-hidden />
          Last active {formatRelativePastLong(relativeIso)}
        </span>
      )}
    </span>
  );
}
