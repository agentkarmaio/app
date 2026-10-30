/**
 * Promotion of Celo x402 relayer settlements out of quarantine.
 *
 * `celo-x402-relayer.ts` writes every settlement into `celo_x402_settlements`,
 * which nothing in scoring reads. This step copies the rows the payment-cycle
 * detector (`src/scoring/payment-cycles.ts`) leaves clean into `transactions`,
 * the table karma reads, with the same row + signal mapping payee mode uses.
 * Flagged rows stay quarantined.
 *
 * Each row is decided exactly once. Promotion cannot be undone, so the graph a
 * row is judged against must already cover the time after it:
 *   - cursor `celo:x402-promotion` holds the ISO block_time decided through;
 *   - cutoff = newest indexed block_time − PROMOTION_HOLD_MS. Anchored on the
 *     indexer, not the wall clock, so a stalled relayer indexer stalls
 *     promotion instead of deciding rows whose aftermath was never indexed;
 *   - rows in (cursor, cutoff] are decided against every settlement in
 *     [cursor − PROMOTION_GRAPH_WINDOW_MS, newest].
 * A cycle that closes later than the hold is missed; after its writes each run
 * re-checks the largest flagged edges against `transactions` and reports any
 * promoted rows on them (`lateFlagged`) rather than silently demoting.
 *
 * Two runs deciding the same slice against different graphs would break
 * decide-once. Every production caller holds the `celo/payments` indexing
 * lease; as a second guard the cursor is re-read right before any write and
 * the run aborts if another run moved it.
 *
 * The graph is folded in TS from a paged read rather than an aggregate RPC: a
 * new PostgREST function is unreachable until a `rest` restart on this cluster.
 * Design: docs/superpowers/specs/2026-10-30-celo-x402-cycle-detector-design.md
 * (kept out of this repo).
 */

import type { Chain, Transaction } from '@/db/schema';
import {
  countCeloX402PromotedOnEdge as dbCountPromotedOnEdge,
  getCeloX402MaxBlockTime as dbGetMaxBlockTime,
  getCeloX402Settlements as dbGetSettlements,
  getCursor as dbGetCursor,
  insertSignalEvents as dbInsertSignalEvents,
  insertTransactions as dbInsertTransactions,
  makeEnsureWallets,
  upsertCursor as dbUpsertCursor,
  type InsertSignalEventInput,
} from '@/db/client';
import {
  detectPaymentCycles,
  edgeKey,
  type CycleReason,
  type PaymentCluster,
  type PaymentEdge,
} from '@/scoring/payment-cycles';
import { toSignalPair, toTransactionRow, type CeloX402Payment } from './celo-x402';

const CELO_CHAIN: Chain = 'celo';

export const CELO_PROMOTION_CURSOR_KEY = 'celo:x402-promotion';
/** A row is decided only once this much newer flow has been indexed after it. */
export const PROMOTION_HOLD_MS = 24 * 60 * 60 * 1000;
/** How far before the decided slice the graph reaches. */
export const PROMOTION_GRAPH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const INSERT_BATCH = 500;
/** Flagged edges (largest first) re-checked against `transactions` per run. */
export const LATE_CHECK_MAX_EDGES = 50;

/** A `celo_x402_settlements` row as PostgREST returns it. */
export interface QuarantinedSettlement {
  tx_hash: string;
  log_index: number;
  /** timestamptz; PostgREST renders `+00:00`, not `Z`. Compare parsed. */
  block_time: string;
  relayer: string;
  payer: string;
  payee: string;
  /** `numeric` comes back as a string. */
  amount: number | string;
}

export interface CeloX402PromotionDeps {
  signal?: AbortSignal;
  /** Decide and report, but write nothing and leave the cursor. */
  dryRun?: boolean;
  /** Newest `block_time` in the quarantine table, or null when it is empty. */
  getMaxBlockTime: () => Promise<string | null>;
  /** Settlements with `fromExclusive < block_time ≤ toInclusive`; null = from the start. */
  getSettlements: (fromExclusive: string | null, toInclusive: string) => Promise<QuarantinedSettlement[]>;
  /** Promoted `transactions` rows on one payer→payee edge. */
  countPromotedOnEdge: (payer: string, payee: string) => Promise<number>;
  ensureWallets: (addresses: string[]) => Promise<void>;
  insertTransactions: (rows: Omit<Transaction, 'id'>[]) => Promise<number>;
  insertSignalEvents: (inputs: InsertSignalEventInput[]) => Promise<number>;
  getCursor: (key: string) => Promise<{ last_signature: string } | null>;
  upsertCursor: (key: string, lastSignature: string) => Promise<void>;
}

export interface CeloX402PromotionResult {
  /** The block_time range decided this run; null when nothing was due. */
  slice: { from: string | null; to: string } | null;
  decided: number;
  /** Rows sent to `transactions` (in dry-run: rows that would be). */
  promoted: Omit<Transaction, 'id'>[];
  /** Rows actually inserted (ON CONFLICT DO NOTHING skips repeats). */
  inserted: number;
  quarantined: { row: QuarantinedSettlement; reasons: CycleReason[] }[];
  clusters: PaymentCluster[];
  /** Flagged edges that already have promoted rows — a cycle closed after the hold. */
  lateFlagged: { payer: string; payee: string; promoted: number; reasons: CycleReason[] }[];
}

const iso = (time: string | number) => new Date(time).toISOString();

function toEdges(rows: QuarantinedSettlement[]): PaymentEdge[] {
  const edges = new Map<string, PaymentEdge>();
  for (const r of rows) {
    const key = edgeKey(r.payer, r.payee, CELO_CHAIN);
    const edge = edges.get(key) ?? { payer: r.payer, payee: r.payee, count: 0, value: 0 };
    edge.count += 1;
    edge.value += Number(r.amount);
    edges.set(key, edge);
  }
  return [...edges.values()];
}

function toPayment(r: QuarantinedSettlement): CeloX402Payment {
  return {
    txHash: r.tx_hash.toLowerCase() as `0x${string}`,
    logIndex: r.log_index,
    from: r.payer.toLowerCase() as `0x${string}`,
    to: r.payee.toLowerCase() as `0x${string}`,
    value: Number(r.amount),
    facilitator: r.relayer.toLowerCase() as `0x${string}`,
  };
}

/** Decide the next slice of quarantined settlements; promote the clean ones. */
export async function celoX402PromotionRun(deps: CeloX402PromotionDeps): Promise<CeloX402PromotionResult> {
  deps.signal?.throwIfAborted();
  const nothing: CeloX402PromotionResult = {
    slice: null, decided: 0, promoted: [], inserted: 0, quarantined: [], clusters: [], lateFlagged: [],
  };

  const newest = await deps.getMaxBlockTime();
  if (newest == null) return nothing;
  const cursor = (await deps.getCursor(CELO_PROMOTION_CURSOR_KEY))?.last_signature ?? null;
  const cutoff = Date.parse(newest) - PROMOTION_HOLD_MS;
  if (cursor != null && Date.parse(cursor) >= cutoff) return nothing;

  const graphFrom = cursor == null ? null : iso(Date.parse(cursor) - PROMOTION_GRAPH_WINDOW_MS);
  const graph = await deps.getSettlements(graphFrom, newest);
  deps.signal?.throwIfAborted();
  const report = detectPaymentCycles(toEdges(graph), CELO_CHAIN);

  const due = graph.filter((r) => {
    const t = Date.parse(r.block_time);
    return (cursor == null || t > Date.parse(cursor)) && t <= cutoff;
  });
  const quarantined: CeloX402PromotionResult['quarantined'] = [];
  const clean: CeloX402Payment[] = [];
  const times: string[] = [];
  for (const r of due) {
    const reasons = report.flagged.get(edgeKey(r.payer, r.payee, CELO_CHAIN));
    if (reasons) {
      quarantined.push({ row: r, reasons });
    } else {
      clean.push(toPayment(r));
      times.push(iso(r.block_time));
    }
  }
  const promoted = clean.map((p, i) => toTransactionRow(p, times[i]));
  const signals = clean.flatMap((p, i) => toSignalPair(p, times[i]));

  let inserted = 0;
  if (!deps.dryRun) {
    const current = (await deps.getCursor(CELO_PROMOTION_CURSOR_KEY))?.last_signature ?? null;
    if (current !== cursor) throw new Error(`promotion_cursor_moved: ${cursor} → ${current}`);
    if (promoted.length > 0) {
      await deps.ensureWallets([...new Set(clean.flatMap((p) => [p.from, p.to]))]);
      for (let i = 0; i < promoted.length; i += INSERT_BATCH) {
        deps.signal?.throwIfAborted();
        inserted += await deps.insertTransactions(promoted.slice(i, i + INSERT_BATCH));
      }
      deps.signal?.throwIfAborted();
      await deps.insertSignalEvents(signals);
      deps.signal?.throwIfAborted();
    }
    await deps.upsertCursor(CELO_PROMOTION_CURSOR_KEY, iso(cutoff));
  }

  // Report only, so it runs after the writes and is capped: a run that times
  // out here has already promoted its slice.
  const lateFlagged: CeloX402PromotionResult['lateFlagged'] = [];
  const flaggedEdges = toEdges(graph)
    .map((edge) => ({ edge, reasons: report.flagged.get(edgeKey(edge.payer, edge.payee, CELO_CHAIN)) }))
    .filter((f): f is { edge: PaymentEdge; reasons: CycleReason[] } => !!f.reasons && !f.reasons.includes('self-payment'))
    .sort((a, b) => b.edge.count - a.edge.count)
    .slice(0, LATE_CHECK_MAX_EDGES);
  for (const { edge, reasons } of flaggedEdges) {
    deps.signal?.throwIfAborted();
    const count = await deps.countPromotedOnEdge(edge.payer, edge.payee);
    if (count > 0) lateFlagged.push({ payer: edge.payer, payee: edge.payee, promoted: count, reasons });
  }

  return {
    slice: { from: cursor, to: iso(cutoff) },
    decided: due.length,
    promoted,
    inserted,
    quarantined,
    clusters: report.clusters,
    lateFlagged,
  };
}

/** Production run against Supabase. `dryRun` reads the real cursor but writes nothing. */
export function runCeloX402Promotion(opts: { dryRun?: boolean; signal?: AbortSignal } = {}): Promise<CeloX402PromotionResult> {
  return celoX402PromotionRun({
    signal: opts.signal,
    dryRun: opts.dryRun,
    getMaxBlockTime: () => dbGetMaxBlockTime(CELO_CHAIN),
    getSettlements: (from, to) => dbGetSettlements(from, to, CELO_CHAIN),
    countPromotedOnEdge: (payer, payee) => dbCountPromotedOnEdge(payer, payee, CELO_CHAIN),
    ensureWallets: makeEnsureWallets(CELO_CHAIN),
    insertTransactions: dbInsertTransactions,
    insertSignalEvents: dbInsertSignalEvents,
    getCursor: async (key) => {
      const c = await dbGetCursor(key, CELO_CHAIN);
      return c ? { last_signature: c.last_signature } : null;
    },
    upsertCursor: async (key, last) => { await dbUpsertCursor(key, last, undefined, CELO_CHAIN); },
  });
}
