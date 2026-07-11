'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ChevronDown } from 'lucide-react';
import type { AkConnectedFeedback } from '@/db/client';
import { agentHref } from '@/lib/agent-href';
import { MetadataBreakdown } from '@/components/karma/metadata-breakdown';

const INITIAL_COUNT = 10;

/**
 * Client island for the "Feedback AgentKarma made on Celo" disclosure list.
 * The /celo server component fetches + sorts the full AkConnectedFeedback[] and
 * passes it down; this component owns only interaction — progressive reveal of
 * the list, and a per-row expand that shows WHY each agent got its score.
 * No data refetch and no client-side scoring: the per-agent v0.2 breakdown is
 * computed server-side (getAkConnectedFeedback) and arrives in
 * record.currentAssessment, already in memory here.
 *
 * Per-row header surfaces the most the data HONESTLY supports. The registry
 * view (readAllFeedback) returns no tx hash and no on-chain timestamp, so there
 * is no per-row Celoscan tx link or date to show — fabricating one would be
 * dishonest. Section-level on-chain verification lives on the page via the AK
 * controller wallet's Celoscan tx list. Per row we show the open scheme
 * (tag1 vN), the on-chain feedbackIndex, the AK rating, a link to the agent,
 * and — expandable — AK's current (v0.2) breakdown of the registration quality.
 */

/** Render the recomputed v0.2 breakdown for one agent via the shared
 *  {@link MetadataBreakdown} panel. The on-chain `value` may be a v0.1
 *  attestation; the panel labels this as AK's CURRENT assessment so a divergence
 *  reads as honest, not contradictory. Falls back to an explainer when the
 *  registration JSON isn't mirrored (nothing to recompute). */
function AssessmentDetail({ record }: { record: AkConnectedFeedback }) {
  const a = record.currentAssessment;
  if (!a) {
    return (
      <p className="px-1 py-2 text-xs text-muted-foreground">
        Registration JSON not mirrored — no current breakdown to recompute.
      </p>
    );
  }
  return (
    <MetadataBreakdown
      result={a.result}
      schemeVersion={a.schemeVersion}
      onChainVersion={record.tag2}
    />
  );
}

function FeedbackRow({ f }: { f: AkConnectedFeedback }) {
  const [open, setOpen] = useState(false);
  const href = f.targetAddress
    ? agentHref({ chain: 'celo', address: f.targetAddress, agentId: f.agentId })
    : `/api/v2/celo/${f.agentId}`;
  // Open scheme label, e.g. "agentkarma_metadata v0.1" / "agentkarma_review v0.1".
  const scheme = `${f.tag1}${f.tag2 ? ` ${f.tag2}` : ''}`;

  return (
    <div
      className={`rounded-lg border border-border bg-card/50 px-4 py-3 ${f.revoked ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className={`truncate font-medium ${f.revoked ? 'line-through' : ''}`}>
            {f.targetName ?? `Agent ${f.agentId}`}
          </div>
          <div className="text-xs text-muted-foreground">
            agentId {f.agentId} · {f.targetFeedbackCount ?? 0} total feedback
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground/80">
            <span className="font-mono">{scheme}</span>
            <span aria-hidden>·</span>
            <span className="font-mono">feedback #{f.feedbackIndex}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-sm">
          <span
            className={`rounded-full px-2 py-0.5 text-xs ${
              f.revoked
                ? 'bg-muted text-muted-foreground'
                : f.kind === 'review'
                  ? 'bg-indigo-500/15 text-indigo-300'
                  : 'bg-emerald-500/15 text-emerald-400'
            }`}
          >
            {f.revoked
              ? 'revoked'
              : `${f.kind === 'review' ? 'Review' : 'AK rated'}: ${f.value}/100`}
          </span>
          {/* Per-row breakdown toggle — only for AK's algorithmic metadata
              records (reviews carry no AK rubric to explain). */}
          {f.kind === 'metadata' && f.currentAssessment && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
            >
              Why
              <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
          )}
          <Link
            href={href}
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowRight className="size-4" />
          </Link>
        </div>
      </div>
      {open && f.kind === 'metadata' && <AssessmentDetail record={f} />}
    </div>
  );
}

export function DisclosureList({ records }: { records: AkConnectedFeedback[] }) {
  const [expanded, setExpanded] = useState(false);

  if (records.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-card/30 px-4 py-6 text-center text-sm text-muted-foreground">
        No published feedback indexed yet.
      </p>
    );
  }

  const visible = expanded ? records : records.slice(0, INITIAL_COUNT);
  const hiddenCount = records.length - INITIAL_COUNT;

  return (
    <div className="space-y-3">
      {visible.map((f) => (
        <FeedbackRow key={`${f.agentId}-${f.client}-${f.kind}-${f.feedbackIndex}`} f={f} />
      ))}

      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full rounded-lg border border-border bg-card/30 px-4 py-2 text-center text-xs font-medium text-muted-foreground transition-colors hover:bg-card/50 hover:text-foreground"
        >
          {expanded ? 'Show less' : `Show all (${records.length})`}
        </button>
      )}
    </div>
  );
}
