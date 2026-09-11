/**
 * Counterparty backfill — the decision layer.
 *
 * `transactions` rows written before 2026-06-20 carry `counterparty = NULL`:
 * the column did not exist yet. The payee is recoverable, because every row
 * carries a unique `tx_signature` — refetch the transaction and re-run the
 * indexer's own decoder. What must NOT happen is a payee being *invented* when
 * the refetch is inconclusive. This is a reputation product; a fabricated
 * counterparty corrupts the exact signal it feeds (scoring/reciprocity.ts).
 *
 * So the write decision is a pure function, separate from the fetching and the
 * updating, and it refuses by default. Every path that does not positively
 * establish the payee returns a reason, never a value. A refused row stays
 * NULL — the state it is already in.
 *
 */

import { normalizeCounterparty } from '@/db/client';
import type { Transaction } from '@/db/schema';

/** Enough of the stored row to verify a decoded payment belongs to it. */
export interface BackfillRow {
  tx_signature: string;
  wallet_address: string;
  facilitator: string;
  /** PostgREST returns `numeric` as a string; both forms are accepted. */
  amount: number | string;
}

export type SkipReason =
  | 'no-payment-decoded'
  | 'no-payee-in-payment'
  | 'signature-mismatch'
  | 'payer-mismatch'
  | 'amount-mismatch'
  | 'self-payment';

export type WriteDecision =
  | { action: 'write'; counterparty: string }
  | { action: 'skip'; reason: SkipReason };

/**
 * Amounts survive a DB round-trip as `numeric(20,6)` strings and come back from
 * the chain as floats, so an exact comparison would reject valid rows. One
 * micro-unit is below the stored scale — tight enough that two different
 * transfers in the same transaction cannot both pass.
 */
const AMOUNT_EPSILON = 1e-6;

/**
 * Decide whether a decoded on-chain payment may fill in `counterparty` for a
 * stored row.
 *
 * Guards run in this order, and the order is part of the contract: the reason
 * returned identifies the FIRST thing that was wrong, so a run's skip histogram
 * reads as a diagnosis rather than a tally.
 *
 *   1. something was decoded at all
 *   2. it is the same transaction        (`tx_signature`)
 *   3. it has the same payer             (`wallet_address`)
 *   4. it is the same payment within it  (`amount`)
 *   5. it names a payee
 *   6. that payee is not the payer       (`normalizeCounterparty`)
 *
 * A payee equal to the *facilitator* is written, not refused: in the canonical
 * direct-to-facilitator settlement the facilitator genuinely is the payee, and
 * the observed SPL destination is evidence either way. What was ruled out in
 * 2026-06 was *assuming* the facilitator without observing it — the opposite of
 * this path.
 */
export function decideCounterpartyWrite(
  row: BackfillRow,
  derived: Omit<Transaction, 'id'> | null,
): WriteDecision {
  if (!derived) return { action: 'skip', reason: 'no-payment-decoded' };
  if (derived.tx_signature !== row.tx_signature) return { action: 'skip', reason: 'signature-mismatch' };
  if (derived.wallet_address !== row.wallet_address) return { action: 'skip', reason: 'payer-mismatch' };

  const stored = typeof row.amount === 'number' ? row.amount : Number.parseFloat(row.amount);
  if (!Number.isFinite(stored) || Math.abs(stored - derived.amount) > AMOUNT_EPSILON) {
    return { action: 'skip', reason: 'amount-mismatch' };
  }

  const payee = derived.counterparty;
  if (payee == null || payee === '') return { action: 'skip', reason: 'no-payee-in-payment' };

  // Same collapse the insert path applies, so a backfilled row is byte-identical
  // to one the live indexer would have written.
  const normalized = normalizeCounterparty(payee, row.wallet_address);
  if (normalized === null) return { action: 'skip', reason: 'self-payment' };

  return { action: 'write', counterparty: normalized };
}

/**
 * Is this refusal permanent?
 *
 * The backfill refetches every row that is still NULL, at roughly 1.5s each on
 * a public RPC. A refusal that can only ever be reached again is dead weight in
 * that set and belongs on the skip-list; a refusal that signals a DISAGREEMENT
 * between the decoder and the stored row does not, because burying it would
 * hide a data problem behind a permanently-quiet run.
 *
 * Conclusive: the decode ran to completion and established that there is no
 * payee to write (no payment for this facilitator in the tx, no destination in
 * the payment, or a destination that collapses to null as a self-payment).
 * Re-running it reaches the same answer.
 *
 * Not conclusive: signature / payer / amount mismatch. Those mean the payment
 * we decoded is not the payment the row describes — worth surfacing on every
 * run until someone looks.
 *
 * An RPC miss never reaches this function: it is retry-eligible by definition.
 */
export function isConclusivelyNull(reason: SkipReason): boolean {
  switch (reason) {
    case 'no-payment-decoded':
    case 'no-payee-in-payment':
    case 'self-payment':
      return true;
    case 'signature-mismatch':
    case 'payer-mismatch':
    case 'amount-mismatch':
      return false;
  }
}
