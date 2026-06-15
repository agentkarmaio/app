import { cn } from '@/lib/utils';

/**
 * StatusPill — marks anything not fully shipped (e.g. Bonding is contingent on
 * founder sign-off to reverse the Tier-1 decision). Used to be honest in the UI
 * about what is live vs planned. Linear-grade, terse.
 */

const TONE: Record<string, string> = {
  planned: 'bg-[rgb(245_166_35/0.10)] text-[#f5a623] border-[rgb(245_166_35/0.22)]',
  live: 'bg-[rgb(16_185_129/0.10)] text-[#10b981] border-[rgb(16_185_129/0.22)]',
  neutral: 'bg-[rgb(255_255_255/0.04)] text-[#8a8f98] border-[rgb(255_255_255/0.08)]',
};

export function StatusPill({
  children,
  tone = 'planned',
  className,
}: {
  children: React.ReactNode;
  tone?: 'planned' | 'live' | 'neutral';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-[510] uppercase tracking-[0.08em]',
        TONE[tone] ?? TONE.neutral,
        className,
      )}
    >
      <span
        aria-hidden
        className="inline-block size-1.5 rounded-full"
        style={{ backgroundColor: 'currentColor' }}
      />
      {children}
    </span>
  );
}
