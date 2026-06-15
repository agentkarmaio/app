import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { SuretyLabel } from '@/db/schema';
import { SURETY_LABEL_META } from '@/lib/succession-format';

/**
 * Surety Karma chip — the underwriter-quality axis (RFC §6.x). Mirrors
 * AutonomyChip exactly: an ORTHOGONAL score shown ALONGSIDE Karma, never folded
 * into Provider or Consumer. Answers "how good is this wallet at judging which
 * agents deliver?" — derived from its bond-underwriting outcomes.
 *
 * A wallet's skill as an underwriter is independent of its skill as an agent, so
 * this chip never touches the trust tier or the confidence badge.
 */

const TOOLTIP =
  'Surety Karma (orthogonal to Karma): how well this wallet judges which agents deliver, '
  + 'from its bond-underwriting outcomes. Shown alongside Karma, never blended into it.';

export function SuretyChip({
  score,
  label,
  size = 'default',
  className,
}: {
  score: number | null | undefined;
  label: SuretyLabel | null | undefined;
  size?: 'sm' | 'default';
  className?: string;
}) {
  if (score == null || label == null) return null;
  const meta = SURETY_LABEL_META[label] ?? SURETY_LABEL_META.unproven;
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
      Surety {score.toFixed(0)} · {meta.label}
    </Badge>
  );
}
