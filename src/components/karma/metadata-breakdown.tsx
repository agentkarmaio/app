'use client';

import { Check, X } from 'lucide-react';
import type { MetadataQualityResult } from '@/scoring/celo-metadata';
import { METADATA_RUBRIC } from '@/scoring/celo-metadata';

/**
 * MetadataBreakdown — the shared "Why did this agent get this score" panel for
 * AK's algorithmic metadata-quality attestation. Renders the recomputed v0.2
 * breakdown for one agent: each rubric dimension with its earned/max points and
 * a pass/fail glyph, plus the scorer notes.
 *
 * The on-chain `value` may be a v0.1 attestation; this is AK's CURRENT
 * assessment, labelled as such so a divergence reads as honest, not
 * contradictory — when `onChainVersion` differs from `schemeVersion` the header
 * shows `on-chain: vX · current assessment: v0.2`.
 *
 * Single source of truth for this rendering. Used in two places:
 *   - the /celo disclosure list (per-row "Why" toggle), and
 *   - the agent-profile "On-chain feedback" card (per AK-metadata record).
 * Both compute the breakdown server-side (pure {@link scoreMetadataQuality}) and
 * pass it in; this island owns only the markup, never any scoring or fetching.
 */
export function MetadataBreakdown({
  result,
  schemeVersion,
  onChainVersion,
}: {
  /** AK's CURRENT (v0.2) deterministic assessment of the registration JSON. */
  result: MetadataQualityResult;
  /** Version of the rubric that produced `result` (AK_VALIDATOR.scheme.tag2). */
  schemeVersion: string;
  /** The version recorded on-chain (the AK record's tag2). May be older. */
  onChainVersion: string;
}) {
  const onChain = onChainVersion || 'v?';
  const diverges = onChain !== schemeVersion;

  return (
    <div className="mt-3 space-y-3 border-t border-border/60 pt-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
        <span className="font-medium uppercase tracking-wider">AK current assessment</span>
        <span className="rounded bg-card px-1.5 py-0.5 font-mono">
          score {result.score}/100
        </span>
        {diverges ? (
          <span className="font-mono">
            on-chain: {onChain} · current assessment: {schemeVersion}
          </span>
        ) : (
          <span className="font-mono">scheme {schemeVersion}</span>
        )}
      </div>

      <ul className="space-y-1">
        {METADATA_RUBRIC.map((dim) => {
          const earned = result.breakdown[dim.key] ?? 0;
          const full = earned >= dim.max;
          const none = earned <= 0;
          return (
            <li key={dim.key} className="flex items-center justify-between gap-3 text-xs">
              <span className="flex min-w-0 items-center gap-1.5">
                {none ? (
                  <X className="size-3 shrink-0 text-muted-foreground/60" aria-hidden />
                ) : (
                  <Check className={`size-3 shrink-0 ${full ? 'text-emerald-400' : 'text-yellow-400'}`} aria-hidden />
                )}
                <span className={`truncate ${none ? 'text-muted-foreground/70' : 'text-foreground'}`}>
                  {dim.label}
                </span>
              </span>
              <span className={`shrink-0 font-mono ${none ? 'text-muted-foreground/60' : 'text-muted-foreground'}`}>
                {earned}/{dim.max}
              </span>
            </li>
          );
        })}
      </ul>

      {result.notes.length > 0 && (
        <div className="space-y-0.5">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80">Notes</div>
          <ul className="space-y-0.5 text-[11px] text-muted-foreground">
            {result.notes.map((n, i) => (
              <li key={i} className="flex gap-1.5">
                <span aria-hidden className="text-muted-foreground/50">•</span>
                <span>{n}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
