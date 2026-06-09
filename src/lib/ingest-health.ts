/**
 * Ingest freshness guard.
 *
 * Born from the 2026-05/06 silent stall: the Helius webhook auto-disabled on
 * 2026-05-21 and the only recovery paths (in-process watchdog, servel cron)
 * were non-functional, so the last indexed transaction sat 17 days stale with
 * nothing detecting it. This pure function is the missing detection: given the
 * latest transaction timestamp it classifies how stale ingest is, so cron
 * runs / health endpoints can alert and trigger recovery instead of plateauing
 * silently.
 *
 * Pure + deterministic (caller passes `nowMs`) so it is trivially testable and
 * usable on both server and client.
 */

export type FreshnessSeverity = 'fresh' | 'warning' | 'critical' | 'unknown';

export interface FreshnessReport {
  /** Echoed input timestamp (ISO) or null when absent/unparseable. */
  lastTxAt: string | null;
  /** Age of the last transaction in ms, or null when it can't be determined. */
  ageMs: number | null;
  /** True whenever freshness is anything other than confirmed-fresh. */
  stale: boolean;
  severity: FreshnessSeverity;
}

/** Ingest older than this is suspicious — webhook may be lagging. */
export const FRESHNESS_WARNING_MS = 2 * 60 * 60 * 1000; // 2h
/** Ingest older than this is an outage — Helius disables after 24h of failures. */
export const FRESHNESS_CRITICAL_MS = 24 * 60 * 60 * 1000; // 24h

export function assessIngestFreshness(
  lastTxAtIso: string | null | undefined,
  nowMs: number,
  opts?: { warningMs?: number; criticalMs?: number },
): FreshnessReport {
  const warningMs = opts?.warningMs ?? FRESHNESS_WARNING_MS;
  const criticalMs = opts?.criticalMs ?? FRESHNESS_CRITICAL_MS;

  if (!lastTxAtIso) {
    return { lastTxAt: null, ageMs: null, stale: true, severity: 'unknown' };
  }

  const parsedMs = new Date(lastTxAtIso).getTime();
  if (Number.isNaN(parsedMs)) {
    return { lastTxAt: null, ageMs: null, stale: true, severity: 'unknown' };
  }

  // Clamp clock skew (a tx timestamped slightly in the future is still fresh).
  const ageMs = Math.max(0, nowMs - parsedMs);

  let severity: FreshnessSeverity;
  if (ageMs >= criticalMs) severity = 'critical';
  else if (ageMs >= warningMs) severity = 'warning';
  else severity = 'fresh';

  return {
    lastTxAt: lastTxAtIso,
    ageMs,
    stale: severity !== 'fresh',
    severity,
  };
}
