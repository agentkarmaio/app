import { cn } from '@/lib/utils';
import type { SuccessionStatus } from '@/db/schema';
import { SUCCESSION_STATUS_META, formatRelativePast } from '@/lib/succession-format';

/**
 * HeartbeatIndicator — the "is this agent still checking in?" read for an Agent
 * Estate card. Shows the derived succession status as a colored dot + plain
 * human line plus the last observed heartbeat (last meaningful on-chain tx).
 *
 * AK indexes the heartbeat from liveness; it never pings the agent. No funds or
 * keys move through AK — heirs act, AK only witnesses.
 */
export function HeartbeatIndicator({
  status,
  lastHeartbeatAt,
  size = 'default',
  className,
}: {
  status: SuccessionStatus;
  lastHeartbeatAt: string | null;
  size?: 'sm' | 'default';
  className?: string;
}) {
  const meta = SUCCESSION_STATUS_META[status] ?? SUCCESSION_STATUS_META.declared;
  const pulse = status === 'live';
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span
        aria-hidden
        className={cn('rounded-full shrink-0', size === 'sm' ? 'size-1.5' : 'size-2', pulse && 'animate-pulse')}
        style={{ backgroundColor: meta.color }}
      />
      <span
        className={cn('font-[510] tracking-[-0.13px]', size === 'sm' ? 'text-[11px]' : 'text-[13px]')}
        style={{ color: meta.color }}
      >
        {meta.human}
      </span>
      {lastHeartbeatAt && (
        <span className="text-[11px] tabular-nums text-[#62666d]">
          · last seen {formatRelativePast(lastHeartbeatAt)}
        </span>
      )}
    </span>
  );
}
