/**
 * Fold a wallet's bounded receipt window into the relationship rollups the
 * agent profile renders: who it pays, who pays it, and which facilitators route
 * the value.
 *
 * Pure and synchronous on purpose. The reads that feed it are windowed in
 * `db/enrichment-queries.ts`; the aggregation happens here in TS rather than in
 * a PostgREST aggregate RPC, because an untracked aggregate function is what
 * caused the /api/stats PGRST202 outage and this cluster's schema cache cannot
 * be reloaded from an app deploy.
 *
 * Two honesty constraints are encoded here rather than left to the view:
 *
 *  - `amount` is the value credited to the counterparty by one transaction, NOT
 *    the payer's outlay (see `transactionsTable.amount`, schema.ts). Every total
 *    this module produces is therefore "credited", and callers must label it so.
 *  - On Solana, `counterparty` is only "an address credited by this
 *    transaction" — `extractX402PaymentCore` can pick a gateway fee account over
 *    the provider. Known facilitator addresses are stripped from the
 *    counterparty rollups by {@link foldCounterparties} and belong in the
 *    facilitator rollup instead, where they are not misread as trade partners.
 *
 * Rows whose payee could not be extracted are COUNTED, never dropped: absent
 * payee data is evidence about the indexer, and hiding it would make a
 * thin-coverage wallet look like a well-understood one. Same discipline as
 * `computeReciprocity`'s coverage gate.
 */

import { ALL_FACILITATOR_ADDRESSES_SET, USDC_MINT, getFacilitatorName } from '@/config/facilitators';
import { isEvmChain } from '@/lib/chain-meta';
import type { Chain } from '@/db/schema';

/** Outbound receipt: this wallet is the payer. */
export interface OutboundRow {
  counterparty: string | null;
  facilitator: string;
  amount: number;
  timestamp: string;
}

/** Inbound receipt: this wallet is the credited counterparty. */
export interface InboundRow {
  wallet_address: string;
  amount: number;
  timestamp: string;
}

export interface RollupEntry {
  /** Address as stored (chain casing preserved). First seen, when grouped by label. */
  address: string;
  /**
   * Human identity this entry was grouped under, when one exists. Facilitators
   * run several addresses under one name (coinbase has seven), so grouping by
   * address would list the same operator repeatedly with fragmented shares.
   * Null when the entry is grouped by address alone.
   */
  label: string | null;
  /** Receipts in this relationship, including any with an unusable amount. */
  count: number;
  /** USDC credited across those receipts. Never the payer's outlay. */
  total: number;
  /** Most recent receipt in this relationship, ISO. */
  lastSeen: string;
}

export interface DirectionSummary {
  entries: RollupEntry[];
  /** Receipts in the window for this direction. */
  receipts: number;
  /** USDC credited across the window. */
  total: number;
  /**
   * Outbound receipts whose payee the indexer could not extract. Zero on the
   * inbound side, where the payer is the row's own `wallet_address`.
   */
  unattributed: number;
  /**
   * Receipts whose credited address is a facilitator AgentKarma tracks. Held
   * apart from {@link unattributed} because the two say different things: this
   * one is "the value went to payment plumbing", the other is "we could not see
   * where the value went". Collapsing them would let a decoder gap masquerade
   * as a routing fee.
   */
  facilitatorCredited: number;
}

export interface PaymentRollups {
  /** Counterparties this wallet pays — the Consumer face. */
  paidTo: DirectionSummary;
  /** Addresses that pay this wallet — the Provider face. */
  earnedFrom: DirectionSummary;
  /** Facilitators routing this wallet's outbound payments. */
  routedVia: RollupEntry[];
  /**
   * At least one window came back full, so these are the most recent N
   * receipts rather than the wallet's whole history. The view must say so.
   */
  saturated: boolean;
}

/**
 * EVM addresses are stored lowercase; Solana base58 and Stellar StrKey are
 * case-sensitive and must not be folded. Getting this backwards silently splits
 * one relationship into two buckets — the Arc address-casing bug that orphaned
 * 83k rows, reproduced in a rollup.
 */
function groupKey(address: string, chain: Chain): string {
  return isEvmChain(chain) ? address.toLowerCase() : address;
}

/** Finite and positive, or it contributes no value. Guards NaN/negative rows. */
function usableAmount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * True when the address is a facilitator AgentKarma already tracks, i.e. payment
 * plumbing rather than a trade counterparty. Solana-only: the facilitator
 * registry is a Solana artifact, and applying it to another chain's addresses
 * would strip real counterparties on an accidental string match.
 */
export function isKnownFacilitatorAddress(address: string, chain: Chain): boolean {
  return chain === 'solana' && ALL_FACILITATOR_ADDRESSES_SET.has(address);
}

/**
 * How a facilitator address should be named in the rollup.
 *
 * `solana-transfers.ts` writes {@link USDC_MINT} into `facilitator` as the
 * sentinel for a plain USDC transfer that went through no facilitator at all
 * (toTransactionRow). Rendering the mint address there would claim the payment
 * was routed by a contract that routes nothing; naming it as a direct transfer
 * is both true and the more useful fact — it says this wallet's flow is not
 * x402-routed.
 */
export function facilitatorLabel(address: string): string | null {
  if (address === USDC_MINT) return 'direct transfer';
  return getFacilitatorName(address);
}

function fold(
  rows: ReadonlyArray<{ address: string | null; amount: number; timestamp: string }>,
  chain: Chain,
  opts: {
    excludeFacilitators: boolean;
    /**
     * Group rows under a shared human identity instead of one bucket per
     * address. Returns null to fall back to address grouping.
     */
    labelOf?: (address: string) => string | null;
  },
): DirectionSummary {
  const byAddress = new Map<string, RollupEntry>();
  let total = 0;
  let unattributed = 0;
  let facilitatorCredited = 0;

  for (const row of rows) {
    const value = usableAmount(row.amount);
    total += value;

    if (!row.address) {
      unattributed += 1;
      continue;
    }
    if (opts.excludeFacilitators && isKnownFacilitatorAddress(row.address, chain)) {
      // Plumbing, not a partner. Not lost — the facilitator rollup keeps it,
      // built from `facilitator` on the same rows.
      facilitatorCredited += 1;
      continue;
    }

    const label = opts.labelOf?.(row.address) ?? null;
    const key = label ?? groupKey(row.address, chain);
    const entry = byAddress.get(key);
    if (entry) {
      entry.count += 1;
      entry.total += value;
      if (row.timestamp > entry.lastSeen) entry.lastSeen = row.timestamp;
    } else {
      byAddress.set(key, {
        address: row.address,
        label,
        count: 1,
        total: value,
        lastSeen: row.timestamp,
      });
    }
  }

  return {
    entries: sortEntries([...byAddress.values()]),
    receipts: rows.length,
    total,
    unattributed,
    facilitatorCredited,
  };
}

/**
 * Value credited first, then receipt count, then address — so the ordering is
 * total and stable across renders rather than dependent on insertion order.
 */
function sortEntries(entries: RollupEntry[]): RollupEntry[] {
  return entries.sort(
    (a, b) =>
      b.total - a.total ||
      b.count - a.count ||
      (a.label ?? a.address).localeCompare(b.label ?? b.address),
  );
}

/** Counterparties this wallet pays, with tracked facilitators stripped out. */
export function foldCounterparties(rows: ReadonlyArray<OutboundRow>, chain: Chain): DirectionSummary {
  return fold(
    rows.map((r) => ({ address: r.counterparty, amount: r.amount, timestamp: r.timestamp })),
    chain,
    { excludeFacilitators: true },
  );
}

/** Addresses that pay this wallet. The payer is the row's own wallet_address. */
export function foldPayers(rows: ReadonlyArray<InboundRow>, chain: Chain): DirectionSummary {
  return fold(
    rows.map((r) => ({ address: r.wallet_address, amount: r.amount, timestamp: r.timestamp })),
    chain,
    { excludeFacilitators: false },
  );
}

/**
 * Facilitators routing this wallet's outbound payments, grouped by OPERATOR
 * rather than by address — coinbase alone runs seven facilitator addresses, and
 * one bucket each would show the same operator five times with a fragmented
 * share. `facilitator` is NOT NULL, so every outbound receipt lands in exactly
 * one bucket and the counts sum to the window, which is what makes the share
 * percentages honest.
 */
export function foldFacilitators(rows: ReadonlyArray<OutboundRow>, chain: Chain): RollupEntry[] {
  return fold(
    rows.map((r) => ({ address: r.facilitator, amount: r.amount, timestamp: r.timestamp })),
    chain,
    { excludeFacilitators: false, labelOf: facilitatorLabel },
  ).entries;
}

export function buildPaymentRollups(input: {
  outbound: ReadonlyArray<OutboundRow>;
  inbound: ReadonlyArray<InboundRow>;
  chain: Chain;
  saturated: boolean;
}): PaymentRollups {
  return {
    paidTo: foldCounterparties(input.outbound, input.chain),
    earnedFrom: foldPayers(input.inbound, input.chain),
    routedVia: foldFacilitators(input.outbound, input.chain),
    saturated: input.saturated,
  };
}
