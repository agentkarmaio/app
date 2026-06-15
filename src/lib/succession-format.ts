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

/**
 * Terse relative-past string ("3h ago", "2d ago", "just now") for a heartbeat
 * timestamp. Null in → "never".
 */
export function formatRelativePast(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'never';
  const secs = Math.max(0, (now.getTime() - then) / 1000);
  if (secs < 60) return 'just now';
  const mins = secs / 60;
  if (mins < 60) return `${Math.round(mins)}m ago`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = hours / 24;
  return `${Math.round(days)}d ago`;
}

/** The interval presets offered in the claim-form succession disclosure. */
export const SUCCESSION_INTERVAL_PRESETS: { label: string; seconds: number }[] = [
  { label: '6 hours', seconds: 6 * 3_600 },
  { label: '1 day', seconds: 24 * 3_600 },
  { label: '7 days', seconds: 7 * 24 * 3_600 },
  { label: '30 days', seconds: 30 * 24 * 3_600 },
  { label: '90 days', seconds: 90 * 24 * 3_600 },
];
