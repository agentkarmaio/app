/**
 * Bond lifecycle projector / indexer (chain-agnostic).
 *
 * Reads the PUBLIC bond lifecycle of an ownerless surety-bond escrow (see
 * contracts/agentkarma-bond-escrow — resolution is edge-authorized: success by
 * the beneficiary, failure permissionless post-deadline) and projects it into
 * AK's read-only state:
 *   - upserts `bonds` (one row per (chain, escrow_ref)),
 *   - upserts `bond_underwriters` (one row per (bond, chain, underwriter)),
 *   - emits Tier-1 `bond_opened` / `bond_resolved` PROVIDER signals via the
 *     scoring helpers.
 *
 * NON-CUSTODY / OBSERVE-ONLY (RFC §12): this projector NEVER holds funds, never
 * resolves a bond, never calls the escrow. It only reads the escrow's emitted
 * `BondOpened` / `BondStaked` / `BondResolved` events and records them.
 *
 * CARDINAL DISCIPLINE: the emitted signals are in `PRESENCE_ONLY_KINDS` — they
 * lift the bonded agent's confidence badge + Tier-1 presence ONLY, never the
 * evidence-gated trust ceiling. The downstream scorer enforces this; the
 * projector's job is purely to record the borrowed-capital signal faithfully.
 *
 * STRUCTURE — built around an injected `BondEventSource` so the SAME projector
 * runs over (a) demo events now (see scripts/seed-demo-bonds.ts) and (b) a real
 * on-chain escrow indexer later (a Helius / viem / Soroban-events source that
 * decodes the contract events into `BondLifecycleEvent`s — drop-in, no projector
 * change). Surety Karma is derived separately by scoring/surety.ts off the
 * `bond_underwriters` rows this writes; it is the orthogonal underwriter axis and
 * is never folded into Provider/Consumer here.
 */

import type { Chain, BondStatus } from '@/db/schema';
import type { IndexRunResult } from '@/chain-adapters/types';
import {
  upsertBond as dbUpsertBond,
  upsertBondUnderwriter as dbUpsertBondUnderwriter,
  upsertWallet as dbUpsertWallet,
  insertSignalEvents as dbInsertSignalEvents,
  type InsertSignalEventInput,
  type UpsertBondInput,
  type UpsertBondUnderwriterInput,
} from '@/db/client';
import { buildBondOpenedSignal, buildBondResolvedSignal } from '@/scoring/signals';

// ─── Lifecycle event shape (mirrors the on-chain contract events) ──────────────
//
// These three variants are the TS projection of the escrow's typed events
// (events.rs: BondOpened / BondStaked / BondResolved). A real indexer decodes
// on-chain logs into exactly this union; the demo seeder constructs it directly.

/** A single underwriter's stake within a bond's funding. */
export interface BondStakeRecord {
  underwriter: string;
  /** Human USDC units (decoded from base units by the event source). */
  amount: number;
}

/** `BondOpened` + the accumulated `BondStaked` events for one bond. */
export interface BondOpenedEvent {
  type: 'opened';
  chain: Chain;
  /** Escrow contract / account id — the bond's durable identity. */
  escrowRef: string;
  bondedAgent: string;
  beneficiary: string;
  /** Opaque off-chain task reference (hash / id). */
  taskRef?: string | null;
  /** Tx that opened the bond (for the signal's per-event dedup ref). */
  openTxHash: string;
  /** Underwriter stakes observed at open / during funding. */
  stakes: BondStakeRecord[];
  observedAt: string | Date;
}

/** `BondResolved` for one bond. `success` distinguishes the two terminal states. */
export interface BondResolvedEvent {
  type: 'resolved';
  chain: Chain;
  escrowRef: string;
  bondedAgent: string;
  beneficiary: string;
  success: boolean;
  /** The resolution tx: the beneficiary-authorized success-release tx (carrying
   *  the recorded DeliveryReceipt), or the post-deadline payout tx (failure). */
  resolveTxHash: string;
  observedAt: string | Date;
}

export type BondLifecycleEvent = BondOpenedEvent | BondResolvedEvent;

/**
 * Source of bond lifecycle events. The demo seeder and a future on-chain escrow
 * indexer both implement this. Returning a flat, ordered list keeps the
 * projector pure orchestration over injected IO (mirrors arc-jobs.ts deps).
 */
export interface BondEventSource {
  /** Ordered lifecycle events to project (opens before their resolves). */
  events: () => Promise<BondLifecycleEvent[]>;
  /** Mark seeded rows visibly. true for the demo source; false for real chains. */
  isDemo: boolean;
}

export interface BondProjectorDeps {
  source: BondEventSource;
  upsertBond: (input: UpsertBondInput) => Promise<string>;
  upsertBondUnderwriter: (input: UpsertBondUnderwriterInput) => Promise<void>;
  insertSignalEvents: (inputs: InsertSignalEventInput[]) => Promise<number>;
  ensureWallet: (address: string, chain: Chain) => Promise<void>;
}

/** Map a resolved event's success flag to the schema BondStatus. */
export function resolvedStatus(success: boolean): BondStatus {
  return success ? 'resolved_success' : 'resolved_failure';
}

/** Sum stake amounts (human USDC). */
export function totalStaked(stakes: BondStakeRecord[]): number {
  return stakes.reduce((acc, s) => acc + (Number.isFinite(s.amount) ? s.amount : 0), 0);
}

/**
 * Project a stream of bond lifecycle events into AK's read-only tables + signals.
 *
 * Order of operations per event (FK-safe):
 *   1. ensure every wallet row exists (bonded agent, beneficiary, underwriters).
 *   2. upsert the bond (keyed (chain, escrow_ref) — idempotent re-index).
 *   3. upsert each underwriter position.
 *   4. buffer the Tier-1 provider signal.
 *
 * `bond_opened` and `bond_resolved` signals are batched and inserted once at the
 * end (idempotent via the (agent_wallet, kind, tx_ref) unique index). A resolve
 * for an escrow not yet opened in this run still upserts the bond (status set to
 * the terminal state) and emits the resolve signal — but it cannot recover the
 * underwriter list or open-time amount from the resolve event alone, so it
 * leaves them to a prior/subsequent open event. In the demo + real flows the
 * open always precedes the resolve, so this is the defensive-only path.
 */
export async function bondProjector(deps: BondProjectorDeps): Promise<IndexRunResult> {
  const events = await deps.source.events();
  const cursors = new Map<string, string>();

  if (events.length === 0) {
    return { fetched: 0, inserted: 0, cursors };
  }

  // Remember per-escrow open context so a later resolve can attribute the right
  // bonded amount / underwriter count to its signal even across events.
  const openContext = new Map<string, { bondedUsdc: number; underwriterCount: number }>();
  const signals: InsertSignalEventInput[] = [];
  let upserted = 0;

  for (const ev of events) {
    if (ev.type === 'opened') {
      const bondedUsdc = totalStaked(ev.stakes);
      const underwriterCount = ev.stakes.length;
      openContext.set(`${ev.chain}:${ev.escrowRef}`, { bondedUsdc, underwriterCount });

      // FK pre-create all referenced wallets on the right chain.
      await deps.ensureWallet(ev.bondedAgent, ev.chain);
      await deps.ensureWallet(ev.beneficiary, ev.chain);
      for (const s of ev.stakes) await deps.ensureWallet(s.underwriter, ev.chain);

      const bondId = await deps.upsertBond({
        chain: ev.chain,
        bondedAgentWallet: ev.bondedAgent,
        beneficiary: ev.beneficiary,
        escrowRef: ev.escrowRef,
        taskRef: ev.taskRef ?? null,
        amount: bondedUsdc,
        status: 'open',
        isDemo: deps.source.isDemo,
        openedAt: ev.observedAt,
      });
      upserted++;

      for (const s of ev.stakes) {
        await deps.upsertBondUnderwriter({
          bondId,
          chain: ev.chain,
          underwriterWallet: s.underwriter,
          stakeAmount: s.amount,
          settled: false,
        });
      }

      signals.push({
        ...buildBondOpenedSignal(ev.bondedAgent, {
          bondId,
          txHash: ev.openTxHash,
          underwriterCount,
          bondedUsdc,
          observedAt: ev.observedAt,
          isDemo: deps.source.isDemo,
        }),
        // Key to the bond's chain so the (chain, agent_wallet) FK + dedup resolve.
        chain: ev.chain,
      });
    } else {
      // resolved
      await deps.ensureWallet(ev.bondedAgent, ev.chain);
      await deps.ensureWallet(ev.beneficiary, ev.chain);

      const ctx = openContext.get(`${ev.chain}:${ev.escrowRef}`) ?? {
        bondedUsdc: 0,
        underwriterCount: 0,
      };

      const bondId = await deps.upsertBond({
        chain: ev.chain,
        bondedAgentWallet: ev.bondedAgent,
        beneficiary: ev.beneficiary,
        escrowRef: ev.escrowRef,
        amount: ctx.bondedUsdc,
        status: resolvedStatus(ev.success),
        resolutionProofTx: ev.resolveTxHash,
        isDemo: deps.source.isDemo,
        resolvedAt: ev.observedAt,
      });
      upserted++;

      signals.push({
        ...buildBondResolvedSignal(ev.bondedAgent, {
          bondId,
          txHash: ev.resolveTxHash,
          outcome: ev.success ? 'success' : 'failure',
          bondedUsdc: ctx.bondedUsdc,
          observedAt: ev.observedAt,
          isDemo: deps.source.isDemo,
        }),
        chain: ev.chain,
      });
    }
  }

  // Mark every underwriter on a resolved bond as settled, with premium credited
  // on success (so Surety Karma derivation sees the outcome). Done in a second
  // pass keyed by the resolve events.
  for (const ev of events) {
    if (ev.type !== 'resolved') continue;
    const openEv = events.find(
      (e): e is BondOpenedEvent =>
        e.type === 'opened' && e.chain === ev.chain && e.escrowRef === ev.escrowRef,
    );
    if (!openEv) continue;
    const bondId = await deps.upsertBond({
      chain: ev.chain,
      bondedAgentWallet: ev.bondedAgent,
      beneficiary: ev.beneficiary,
      escrowRef: ev.escrowRef,
      amount: totalStaked(openEv.stakes),
      status: resolvedStatus(ev.success),
      resolutionProofTx: ev.resolveTxHash,
      isDemo: deps.source.isDemo,
      resolvedAt: ev.observedAt,
    });
    for (const s of openEv.stakes) {
      await deps.upsertBondUnderwriter({
        bondId,
        chain: ev.chain,
        underwriterWallet: s.underwriter,
        stakeAmount: s.amount,
        settled: true,
        // On success, underwriters earn a flat 5% premium of their stake; on
        // failure they earn nothing (stake paid the beneficiary). This is a
        // PROJECTION display figure — the escrow contract is the source of truth
        // for actual flows; AK never moves these funds.
        premiumEarned: ev.success ? round6(s.amount * 0.05) : 0,
      });
    }
  }

  const inserted = await deps.insertSignalEvents(signals);
  return { fetched: events.length, inserted, cursors };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// ─── Production wiring ──────────────────────────────────────────────────────

/**
 * Run the projector over an injected event source against the live DB.
 *
 * SCOPE (this round): DEMO-FED ONLY. The single caller is the demo seeder
 * (scripts/seed-demo-bonds.ts), which builds a `BondEventSource` of labeled
 * fixtures with `isDemo: true`. There is deliberately NO scheduled bond indexer:
 * no `/api/cron/bond` route, no GH workflow, and no per-chain `bond`
 * indexer_cursor — bonds are not yet ingested from a live escrow (the
 * agentkarma-bond-escrow contract is authored but NOT deployed, founder
 * decision). Scoping it that way avoids a silent, unscheduled half-indexer.
 *
 * PHASE 2 (real-escrow ingestion, when the escrow is deployed): provide a
 * chain-backed `BondEventSource` with `isDemo: false` (Soroban events / Helius /
 * viem getLogs) — the projector is unchanged — and add the scheduled drain
 * mirroring the heartbeat path: `/api/cron/bond` + a GH workflow + a per-chain
 * `bond` indexer_cursor (see .github/workflows/heartbeat-drain.yml and
 * src/app/api/cron/heartbeat/route.ts as the templates).
 */
export async function runBondProjector(source: BondEventSource): Promise<IndexRunResult> {
  return bondProjector({
    source,
    upsertBond: dbUpsertBond,
    upsertBondUnderwriter: dbUpsertBondUnderwriter,
    insertSignalEvents: dbInsertSignalEvents,
    ensureWallet: async (address, chain) => {
      await dbUpsertWallet(address, 0, 'Unrated', 0, {}, chain);
    },
  });
}
