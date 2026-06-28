/**
 * Plain-language formatting for succession + bond UI.
 *
 * Pure, IO-free display helpers shared by the in-product surfaces (agent
 * profile, Agent Estates, the claim disclosure). Copy obeys the project voice:
 * AK OBSERVES, never holds or executes — verbs stay connect / declare / track /
 * witness / index. Never create / deposit / fund / hold / execute.
 */

import type { SuccessionStatus, SuretyLabel } from '@/db/schema';

/** Human-facing label + dot color per derived succession status. */
export const SUCCESSION_STATUS_META: Record<
  SuccessionStatus,
  { label: string; human: string; color: string }
> = {
  declared: {
    label: 'Declared',
    human: 'Plan declared — staying alive raises trust, not the plan itself',
    color: '#8a8f98',
  },
  live: {
    label: 'Checking in',
    human: 'Checking in normally',
    color: '#10b981',
  },
  lapsing: {
    label: 'Missed check-in',
    human: 'Missed last check-in',
    color: '#f5a623',
  },
  lapsed: {
    label: 'Lapsed',
    human: 'Lapsed — heir can act',
    color: '#e5484d',
  },
  executed: {
    label: 'Executed',
    human: 'Inheritance observed on-chain',
    color: '#828fff',
  },
  revoked: {
    label: 'Revoked',
    human: 'Owner cancelled the plan',
    color: '#62666d',
  },
};

/** Surety Karma label → display color (orthogonal axis, indigo family). */
export const SURETY_LABEL_META: Record<SuretyLabel, { label: string; color: string }> = {
  reliable: { label: 'Reliable', color: '#10b981' },
  mixed: { label: 'Mixed', color: '#f5a623' },
  unproven: { label: 'Unproven', color: '#8a8f98' },
};

/**
 * Render a declared heartbeat interval (seconds) as a terse human cadence:
 * "every 6h", "every 3d", "every 30d". Used in builder + human copy alike.
 */
export function formatInterval(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const hours = seconds / 3_600;
  if (hours < 24) {
    const h = Math.round(hours);
    return `every ${h}h`;
  }
  const days = hours / 24;
  const d = Math.round(days);
  return `every ${d}d`;
}

type RelUnit = 'minute' | 'hour' | 'day' | 'month' | 'year';

const TERSE_SUFFIX: Record<RelUnit, string> = {
  minute: 'm',
  hour: 'h',
  day: 'd',
  month: 'mo',
  year: 'y',
};

const RTF_LONG = new Intl.RelativeTimeFormat('en', { numeric: 'always' });

/**
 * Bucket an elapsed-past duration into the coarsest sensible {value, unit}.
 * 'just now' for sub-minute; null for null/unparseable input. The single source
 * of bucket boundaries shared by the terse and verbose formatters below.
 */
function relativePastParts(
  iso: string | null,
  now: Date,
): { value: number; unit: RelUnit } | 'just now' | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const secs = Math.max(0, (now.getTime() - then) / 1000);
  if (secs < 60) return 'just now';
  const mins = secs / 60;
  if (mins < 60) return { value: Math.round(mins), unit: 'minute' };
  const hours = mins / 60;
  if (hours < 24) return { value: Math.round(hours), unit: 'hour' };
  const days = hours / 24;
  if (days < 30) return { value: Math.round(days), unit: 'day' };
  const months = days / 30;
  if (months < 12) return { value: Math.round(months), unit: 'month' };
  return { value: Math.round(days / 365), unit: 'year' };
}

/**
 * Terse relative-past string ("3h ago", "2d ago", "3mo ago", "just now") for a
 * timestamp. Used for heartbeats. Null in → "never".
 */
export function formatRelativePast(iso: string | null, now: Date = new Date()): string {
  const parts = relativePastParts(iso, now);
  if (parts === null) return 'never';
  if (parts === 'just now') return 'just now';
  return `${parts.value}${TERSE_SUFFIX[parts.unit]} ago`;
}

/**
 * Verbose relative-past string ("8 hours ago", "2 months ago", "1 year ago")
 * for "last active"–style display. Localized via Intl. Null in → "never".
 */
export function formatRelativePastLong(iso: string | null, now: Date = new Date()): string {
  const parts = relativePastParts(iso, now);
  if (parts === null) return 'never';
  if (parts === 'just now') return 'just now';
  return RTF_LONG.format(-parts.value, parts.unit);
}

/** The interval presets offered in the claim-form succession disclosure. */
export const SUCCESSION_INTERVAL_PRESETS: { label: string; seconds: number }[] = [
  { label: '6 hours', seconds: 6 * 3_600 },
  { label: '1 day', seconds: 24 * 3_600 },
  { label: '7 days', seconds: 7 * 24 * 3_600 },
  { label: '30 days', seconds: 30 * 24 * 3_600 },
  { label: '90 days', seconds: 90 * 24 * 3_600 },
];
