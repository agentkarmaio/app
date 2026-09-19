import type { Chain } from '@/db/schema';

export type IndexingPath = 'payments' | 'escrow' | 'transfers' | 'registry';
export const INDEXING_PATHS: ReadonlyArray<{
  chain: Chain;
  path: IndexingPath;
  label: string;
  intervalMs: number;
}> = [
  {
    chain: 'solana',
    path: 'payments',
    label: 'Payments',
    intervalMs: 3_600_000,
  },
  {
    chain: 'solana',
    path: 'registry',
    label: 'Agent registry',
    intervalMs: 86_400_000,
  },
  {
    chain: 'arc',
    path: 'escrow',
    label: 'Job settlements',
    intervalMs: 300_000,
  },
  {
    chain: 'arc',
    path: 'transfers',
    label: 'Agent transfers',
    intervalMs: 300_000,
  },
  {
    chain: 'arc',
    path: 'registry',
    label: 'Selected agent registry',
    intervalMs: 900_000,
  },
  {
    chain: 'celo',
    path: 'payments',
    label: 'Verified payment targets',
    intervalMs: 300_000,
  },
  {
    chain: 'celo',
    path: 'registry',
    label: 'Agent registry',
    intervalMs: 21_600_000,
  },
  {
    chain: 'stellar',
    path: 'transfers',
    label: 'Agent transfers',
    intervalMs: 300_000,
  },
  {
    chain: 'stellar',
    path: 'registry',
    label: 'Agent registry',
    intervalMs: 3_600_000,
  },
  { chain: 'arc-mainnet', path: 'transfers', label: 'Agent transfers', intervalMs: 300_000 },
  { chain: 'arc-mainnet', path: 'registry', label: 'Agent registry', intervalMs: 900_000 },
];
export type IndexingStatus =
  | 'current'
  | 'running'
  | 'catching_up'
  | 'dormant'
  | 'disabled'
  | 'failed'
  | 'delayed'
  | 'unknown';
export interface HealthStateRow {
  chain: string;
  path: string;
  enabled: boolean;
  status: string | null;
  error_code?: string | null;
  last_attempt_at: string | null;
  last_finished_at: string | null;
  last_success_at: string | null;
  interval_ms: number;
  lease_until: string | null;
  owner: string | null;
  checkpoint: string | null;
  head: string | null;
  checked_count: number;
  pending_count: number;
  unresolved_count: number;
  gaps_count?: number;
  inserted_count: number;
}
const ms = (s: string | null) => (s ? Date.parse(s) : NaN);
function stateStatus(
  row: HealthStateRow | undefined,
  now: number,
): IndexingStatus {
  if (!row) return 'unknown';
  if (!row.enabled) return 'disabled';
  // Only a LIVE lease proves a run is in flight. An expired one is an orphan
  // left by a worker that died before releasing, and it survives until the next
  // acquire steals it — a whole interval of saying "delayed" about data that may
  // be seconds old. Freshness is `last_finished_at`'s to decide, below.
  if (row.owner && ms(row.lease_until) > now) return 'running';
  if (row.status === 'failed') return 'failed';
  if (!row.last_finished_at) return 'unknown';
  if (
    !Number.isFinite(ms(row.last_finished_at)) ||
    now - ms(row.last_finished_at) > Math.max(60_000, row.interval_ms * 2)
  )
    return 'delayed';
  if (row.status === 'dormant') return 'dormant';
  // Holes in OLD history are not a statement about TODAY's data. `gaps_count` is
  // a permanent ledger — retained by greatest() and cleared only by operator
  // recovery — so counting it as backlog pins a path to "catching up" for good,
  // and `finish_indexing_run` compounds that by rewriting caught_up →
  // catching_up whenever gaps survive. Gaps are disclosed as `history_gap`
  // through `publicIssue`; the freshness verdict must not say it a second time.
  //
  // Safe to derive: `caught_up` is impossible with outstanding work — the SQL
  // raises `indexing_coverage_incomplete` when either count is non-zero — so
  // zero pending AND zero unresolved can only mean the scan finished its window.
  const backlogged = row.pending_count > 0 || row.unresolved_count > 0;
  if (backlogged) return 'catching_up';
  if ((row.gaps_count ?? 0) > 0) return 'current';
  if (row.status === 'catching_up') return 'catching_up';
  return row.status === 'caught_up' && row.last_success_at
    ? 'current'
    : 'unknown';
}
const priority: IndexingStatus[] = [
  'failed',
  'delayed',
  'unknown',
  'catching_up',
  'running',
  'disabled',
  'dormant',
  'current',
];
const worst = (states: IndexingStatus[]) =>
  priority.find((s) => states.includes(s)) ?? 'unknown';
export type IndexingIssue = 'rate_limited' | 'registry_retry' | 'history_gap';
function publicIssue(row: HealthStateRow | undefined, now: number): IndexingIssue | null {
  if (!row || !row.enabled) return null;
  if ((row.gaps_count ?? 0) > 0 || row.error_code === 'archive_gap') return 'history_gap';
  if (stateStatus(row, now) === 'running') return null;
  if (row.error_code === 'rpc_rate_limited' || row.error_code === 'rate_limited') return 'rate_limited';
  if (row.error_code === 'registry_read_failure' || row.error_code === 'retry_backlog')
    return 'registry_retry';
  return null;
}
/** A small explicit projection: never serialize the private worker row. */
export function buildIndexingHealth(rows: HealthStateRow[], now = Date.now()) {
  const chains = (['solana', 'arc', 'celo', 'stellar', 'arc-mainnet'] as Chain[]).map(
    (chain) => {
      const paths = INDEXING_PATHS.filter((p) => p.chain === chain).map(
        (def) => {
          const row = rows.find(
            (r) => r.chain === chain && r.path === def.path,
          );
          return {
            path: def.path,
            label: def.label,
            status: stateStatus(row, now),
            issue: publicIssue(row, now),
            lastAttemptAt: row?.last_attempt_at ?? null,
            lastSuccessAt: row?.last_success_at ?? null,
            lastCheckedAt: row?.last_finished_at ?? null,
            checked: row?.checked_count ?? 0,
            pending: row?.pending_count ?? 0,
            unresolved: (row?.unresolved_count ?? 0) + (row?.gaps_count ?? 0),
            inserted: row?.inserted_count ?? 0,
          };
        },
      );
      return { chain, status: worst(paths.map((p) => p.status)), paths };
    },
  );
  return {
    checkedAt: new Date(now).toISOString(),
    status: worst(chains.map((c) => c.status)),
    chains,
  };
}
export type IndexingHealth = ReturnType<typeof buildIndexingHealth>;
