import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { AutonomyLabel } from '@/db/schema';

/**
 * Autonomy Confidence chip (RFC v0.3 §5.5). Orthogonal to Karma — renders the
 * numeric 0–100 autonomy score + qualitative label (agent-like / mixed /
 * human-like). MUST appear alongside, never inside, the karma score.
 */

const CONFIG: Record<AutonomyLabel, { color: string; className: string; tooltip: string }> = {
  'agent-like': {
    color: '#7170ff',
    className: 'bg-[rgb(113_112_255/0.12)] text-[#9c9bff] border-[rgb(113_112_255/0.22)]',
    tooltip: 'Behavioral fingerprint is consistent with autonomous operation — 24/7 activity, low-variance cadence, or high counterparty breadth.',
  },
  'mixed': {
    color: '#f5a623',
    className: 'bg-[rgb(245_166_35/0.12)] text-[#f5a623] border-[rgb(245_166_35/0.22)]',
    tooltip: 'Some agent-like signals present, but evidence is not conclusive.',
  },
  'human-like': {
    color: '#8a8f98',
    className: 'bg-[rgb(255_255_255/0.04)] text-[#8a8f98] border-[rgb(255_255_255/0.08)]',
    tooltip: 'Activity patterns resemble human usage rather than autonomous operation.',
  },
};

export function AutonomyChip({
  score,
  label,
  size = 'default',
  className,
}: {
  score: number | null | undefined;
  label: AutonomyLabel | null | undefined;
  size?: 'sm' | 'default';
  className?: string;
}) {
  if (score == null || label == null) return null;
  const config = CONFIG[label] ?? CONFIG['human-like'];
  return (
    <Badge
      variant="outline"
      title={config.tooltip}
      className={cn(
        'font-[510] tracking-[-0.13px] gap-1',
        size === 'sm' && 'text-[10px] px-1.5 py-0',
        config.className,
        className,
      )}
    >
      <span
        aria-hidden
        className="inline-block size-1.5 rounded-full"
        style={{ backgroundColor: config.color }}
      />
      Autonomy {score.toFixed(0)} · {label}
    </Badge>
  );
}
