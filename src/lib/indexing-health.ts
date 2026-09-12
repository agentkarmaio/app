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
  if (row.owner) return ms(row.lease_until) > now ? 'running' : 'delayed';
  if (row.status === 'failed') return 'failed';
  if (!row.last_finished_at) return 'unknown';
  if (
    !Number.isFinite(ms(row.last_finished_at)) ||
    now - ms(row.last_finished_at) > Math.max(60_000, row.interval_ms * 2)
  )
    return 'delayed';
  if (row.status === 'dormant') return 'dormant';
  if (
    row.status === 'catching_up' ||
    row.pending_count > 0 ||
    row.unresolved_count > 0 ||
    (row.gaps_count ?? 0) > 0
  )
    return 'catching_up';
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
/** A small explicit projection: never serialize the private worker row. */
export function buildIndexingHealth(rows: HealthStateRow[], now = Date.now()) {
  const chains = (['solana', 'arc', 'celo', 'stellar'] as Chain[]).map(
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
