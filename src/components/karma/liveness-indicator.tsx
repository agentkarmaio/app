import { cn } from '@/lib/utils';
import type { LivenessStatus } from '@/db/schema';
import { getLivenessStatus } from '@/db/schema';

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
  className,
}: {
  lastSeen?: string | Date;
  status?: LivenessStatus;
  size?: 'sm' | 'default';
  className?: string;
}) {
  const status = statusOverride ?? (lastSeen ? getLivenessStatus(lastSeen) : 'Inactive');
  const config = LIVENESS_CONFIG[status];

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
    </span>
  );
}
