/**
 * Settlement Quality badge — the display surface for the receipt-gated delivery
 * axis (src/scoring/settlement-quality.ts). Presentational + server-safe (no
 * "use client"): renders the reliable/mixed/unproven confidence badge that
 * AgentKarma already speaks, plus an honest detail line. Never fabricates a
 * percentage — a farmed agent (self-issued reviews, unpaired settlements) reads
 * Unproven, and an agent with no receipts renders "no receipts", not a zero.
 *
 * `SettlementQualityPill` is the bare label chip (used in explainers / legends);
 * `SettlementQualityBadge` composes it with the receipt/counterparty detail for
 * a concrete agent.
 */

import type { SettlementLabel, SettlementQualityResult } from '@/scoring/settlement-quality';

const TONE: Record<SettlementLabel, { dotClassName: string; title: string; className: string }> = {
  reliable: {
    dotClassName: 'bg-emerald-400',
    title: 'Reliable',
    className: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  },
  mixed: {
    dotClassName: 'bg-amber-400',
    title: 'Mixed',
    className: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  },
  unproven: {
    dotClassName: 'bg-slate-400',
    title: 'Unproven',
    className: 'border-slate-400/30 bg-slate-400/10 text-slate-300',
  },
};

export function SettlementQualityPill({ label }: { label: SettlementLabel }) {
  const tone = TONE[label];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone.className}`}
    >
      <span aria-hidden className={`size-1.5 rounded-full ${tone.dotClassName}`} />
      {tone.title}
    </span>
  );
}

/** Honest one-line detail: receipts + distinct counterparties, or the empty state. */
function detailFor(result: SettlementQualityResult): string {
  const { settledCount, distinctCounterparties, sybilFunnel } = result;
  if (settledCount === 0) return 'no settlement receipts';
  const receipts = `${settledCount} settlement${settledCount === 1 ? '' : 's'}`;
  const parties = `${distinctCounterparties} counterpart${distinctCounterparties === 1 ? 'y' : 'ies'}`;
  const base = `${receipts} · ${parties}`;
  return sybilFunnel ? `${base} · funnel flagged` : base;
}

/**
 * Full badge for a concrete agent. Pass `null` when the agent has no receipts at
 * all (renders ⚪ Unproven · "no settlement receipts") — mirrors computeSettlementQuality
 * returning null so callers never have to special-case the empty state.
 */
export function SettlementQualityBadge({ result }: { result: SettlementQualityResult | null }) {
  const label: SettlementLabel = result?.label ?? 'unproven';
  const detail = result ? detailFor(result) : 'no settlement receipts';
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <SettlementQualityPill label={label} />
      <span className="text-xs text-muted-foreground">{detail}</span>
    </span>
  );
}
