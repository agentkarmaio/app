import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { SuccessionStatus } from '@/db/schema';
import { SUCCESSION_STATUS_META } from '@/lib/succession-format';

/**
 * Succession (Dead Man's Switch) status chip. Renders the live derived heartbeat
 * status of a declared agent will (RFC §13). AK OBSERVES the lifecycle; it never
 * holds a key, holds funds, or executes the will.
 *
 * CEILING DISCIPLINE: a declared will lifts Tier-presence + (with accrued
 * heartbeats) the confidence badge — it NEVER raises the trust-tier ceiling, and
 * a bare 'declared' status alone never moves the badge off ⚪. The tooltip
 * carries the orthogonality guard: the heartbeat feeds Karma durability only,
 * never Autonomy (the same observation is never double-counted).
 */

const TOOLTIP =
  'Dead Man’s Switch: AK derives this from on-chain liveness, never from a manual ping. '
  + 'Declaring a plan doesn’t raise your score — staying alive does. '
  + 'The heartbeat feeds Karma durability only; Autonomy reads activity cadence separately, never double-counted.';

export function SuccessionChip({
  status,
  size = 'default',
  className,
}: {
  status: SuccessionStatus | null | undefined;
  size?: 'sm' | 'default';
  className?: string;
}) {
  if (status == null) return null;
  const meta = SUCCESSION_STATUS_META[status] ?? SUCCESSION_STATUS_META.declared;
  return (
    <Badge
      variant="outline"
      title={TOOLTIP}
      className={cn(
        'font-[510] tracking-[-0.13px] gap-1 bg-[rgb(255_255_255/0.04)] border-[rgb(255_255_255/0.08)]',
        size === 'sm' && 'text-[10px] px-1.5 py-0',
        className,
      )}
      style={{ color: meta.color }}
    >
      <span
        aria-hidden
        className="inline-block size-1.5 rounded-full"
        style={{ backgroundColor: meta.color }}
      />
      Succession · {meta.label}
    </Badge>
  );
}
