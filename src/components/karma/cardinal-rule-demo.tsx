'use client';

/* CardinalRuleDemo — the one screen that proves the cardinal rule of bonding:
 * a bond lifts the CONFIDENCE BADGE (🟡 behavior-inferred → 🟢 receipt-backed)
 * but NEVER the trust-tier ceiling. The TierBadge stays visibly pinned at
 * "Good" across the whole animation while the badge flips on bond_resolved.
 *
 * Observe-only framing: copy says "we witness the bond, never hold the funds".
 * No funds move; this is a sample row replaying an indexed lifecycle.
 */

import { useEffect, useState } from 'react';
import { ConfidenceBadge } from '@/components/karma/confidence-badge';
import { TierBadge } from '@/components/karma/tier-badge';

type Phase = 'before' | 'resolving' | 'after';

const SEQUENCE: { phase: Phase; ms: number }[] = [
  { phase: 'before', ms: 2600 },
  { phase: 'resolving', ms: 1100 },
  { phase: 'after', ms: 3200 },
];

export function CardinalRuleDemo() {
  const [step, setStep] = useState(0);
  const phase = SEQUENCE[step].phase;

  useEffect(() => {
    const t = setTimeout(
      () => setStep((s) => (s + 1) % SEQUENCE.length),
      SEQUENCE[step].ms,
    );
    return () => clearTimeout(t);
  }, [step]);

  const badge = phase === 'after' ? 'receipt-backed' : 'behavior-inferred';

  return (
    <div className="rounded-xl border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] p-5">
      <div className="flex items-center justify-between">
        <p className="text-[10.5px] font-[510] uppercase tracking-[0.14em] text-[#62666d]">
          Sample agent · live replay
        </p>
        <span
          className={
            'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-[510] uppercase tracking-[0.12em] transition-colors ' +
            (phase === 'resolving'
              ? 'border border-[rgb(245_166_35/0.25)] bg-[rgb(245_166_35/0.08)] text-[#f5a623]'
              : phase === 'after'
                ? 'border border-[rgb(16_185_129/0.20)] bg-[rgb(16_185_129/0.08)] text-[#a3d6bd]'
                : 'border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] text-[#8a8f98]')
          }
        >
          <span
            aria-hidden
            className={
              'size-1 rounded-full ' +
              (phase === 'resolving'
                ? 'bg-[#f5a623]'
                : phase === 'after'
                  ? 'bg-[#10b981]'
                  : 'bg-[#62666d]')
            }
          />
          {phase === 'resolving'
            ? 'bond_resolved'
            : phase === 'after'
              ? 'witnessed on-chain'
              : 'bond open'}
        </span>
      </div>

      <div className="mt-4 flex items-center gap-2 font-mono text-[12px] text-[#d0d6e0]">
        agent_9f3c…b21a
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4">
        {/* Confidence badge — MOVES */}
        <div className="space-y-1.5">
          <p className="text-[10px] font-[510] uppercase tracking-[0.14em] text-[#62666d]">
            Confidence
          </p>
          <div className="transition-opacity duration-500">
            <ConfidenceBadge badge={badge} />
          </div>
          <p className="text-[10.5px] leading-relaxed text-[#62666d]">
            {phase === 'after'
              ? '🟢 lifted by the resolved bond'
              : '🟡 awaiting corroboration'}
          </p>
        </div>

        {/* Trust tier — PINNED */}
        <div className="space-y-1.5">
          <p className="text-[10px] font-[510] uppercase tracking-[0.14em] text-[#62666d]">
            Trust tier
            <span className="ml-1.5 normal-case tracking-normal text-[#4f5258]">
              (ceiling)
            </span>
          </p>
          <div className="flex items-center gap-1.5">
            <TierBadge tier="Good" />
            <span
              aria-hidden
              title="Ceiling pinned — evidence-gated"
              className="text-[11px] text-[#4f5258]"
            >
              🔒
            </span>
          </div>
          <p className="text-[10.5px] leading-relaxed text-[#62666d]">
            Pinned — borrowed capital can&apos;t buy a tier.
          </p>
        </div>
      </div>

      <p className="mt-4 border-t border-[rgb(255_255_255/0.06)] pt-3 text-[11px] leading-relaxed text-[#8a8f98]">
        A bond lifts the confidence badge, never the trust-tier ceiling. No
        thin-file agent reaches Excellent on a sponsor&apos;s stake. AgentKarma
        witnesses the bond on-chain — it never holds or moves the funds.
      </p>
    </div>
  );
}
