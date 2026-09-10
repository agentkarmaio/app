/**
 * Reciprocity / revenue independence — how much of a wallet's inbound value
 * arrives from addresses it also pays.
 *
 * The question a lender actually asks: is this revenue earned, or is it the
 * operator cycling USDC through its own wallets? `calculateScore()` does not
 * answer it. Its only anti-gaming rule is the Sybil funnel cap on `loyalty`
 * (few counterparties, many transactions), which a two-address payment loop
 * clears comfortably on the provider face.
 *
 * Additive by design: nothing here feeds `calculateScore()`. Blending it into
 * the composite would move every wallet's score and cascade to `rank_score`,
 * which is a separate decision. This module reports; it does not re-rank.
 *
 * Distinct from `farm-detector.ts`'s `selfDealtRatio`, which works at the
 * SETTLEMENT level (an ERC-8183 job whose client and provider are the same
 * party). This works at the PAYMENT-FLOW level: value cycling between two
 * distinct addresses over many transactions. Same family, different evidence —
 * the names stay separate so a reader can tell which one produced a flag.
 *
 * Spec: (design notes, kept out of this repo)
 */

import { isEvmChain } from '@/lib/chain-meta';
import type { Chain } from '@/db/schema';

/**
 * Minimum share of a wallet's outbound rows that must carry a payee before the
 * reciprocity read is trustworthy. Below it the verdict is `insufficient-data`.
 *
 * This gate is the whole safety story. 503k Solana rows carry `counterparty =
 * NULL` (payee underivable), and a payment recorded that way never matches the
 * inbound lookup — it is invisible. If a circular payer's rows are NULL, the
 * wallet looks MORE independent than it is, which for an underwriter is the
 * worst possible failure: a confident "clean" verdict on self-dealt revenue.
 * So we measure how well the indexer sees payees for this wallet at all, and
 * decline to answer when it doesn't.
 */
export const COVERAGE_FLOOR = 0.5;

/** `reciprocalShare` at or above this reads as `circular`. */
export const CIRCULAR_THRESHOLD = 0.7;

/** `reciprocalShare` at or above this reads as `mixed`, below it `independent`. */
export const MIXED_THRESHOLD = 0.3;

export interface ReciprocityInput {
  /**
   * The wallet's outbound payments (`WHERE wallet_address = W`). Rows with a
   * null `counterparty` count against coverage rather than being dropped —
   * they are the evidence that the indexer cannot see payees here.
   */
  outbound: ReadonlyArray<{ counterparty: string | null; amount: number }>;
  /**
   * Inbound value aggregated per payer — one entry per address that pays W.
   * The caller decides how to produce it; `getPaymentFlowsForAddress()` reads a
   * bounded recent window and folds it in TS rather than using a PostgREST
   * aggregate RPC, because an untracked aggregate function is what caused the
   * /api/stats PGRST202 outage and the schema cache cannot be reloaded from an
   * app deploy on this cluster. Either way, never an unbounded row pull: a
   * popular resource server has tens of thousands of payers.
   */
  inbound: ReadonlyArray<{ payer: string; total: number; count: number }>;
  chain: Chain | string;
}

export type ReciprocityVerdict = 'independent' | 'mixed' | 'circular' | 'insufficient-data';

export interface ReciprocityResult {
  /** Share of inbound value from addresses the wallet also pays. Null when undecidable. */
  reciprocalShare: number | null;
  /** `1 - reciprocalShare`. The headline number for a lender. Null when undecidable. */
  independentShare: number | null;
  inboundTotal: number;
  reciprocalTotal: number;
  payerCount: number;
  reciprocalPayerCount: number;
  /** Share of outbound rows carrying a payee. Drives the gate. */
  coverage: number;
  verdict: ReciprocityVerdict;
}

/**
 * EVM addresses are stored lowercase; Solana base58 and Stellar StrKey are
 * case-sensitive and must not be folded. Getting this backwards silently breaks
 * the set intersection — the same class of bug as the Arc address-casing split
 * that orphaned 83k rows.
 */
function normalizeAddress(address: string, chain: Chain | string): string {
  return isEvmChain(chain as Chain) ? address.toLowerCase() : address;
}

/** Finite and positive, or it does not contribute. Guards NaN/negative rows. */
function usableAmount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function verdictFor(share: number): Exclude<ReciprocityVerdict, 'insufficient-data'> {
  if (share >= CIRCULAR_THRESHOLD) return 'circular';
  if (share >= MIXED_THRESHOLD) return 'mixed';
  return 'independent';
}

const UNDECIDABLE = {
  reciprocalShare: null,
  independentShare: null,
  verdict: 'insufficient-data' as const,
};

/**
 * Compute the reciprocity read for one wallet.
 *
 * Undecidable — `insufficient-data`, shares null — when any of:
 *   - outbound coverage is below {@link COVERAGE_FLOOR} (indexer can't see payees)
 *   - there are no outbound rows at all (nothing to be reciprocal WITH)
 *   - inbound value totals zero (nothing to take a share of)
 *
 * `insufficient-data` never means independent. That distinction is the point.
 */
export function computeReciprocity(input: ReciprocityInput): ReciprocityResult {
  const { outbound, inbound, chain } = input;

  const payees = new Set(
    outbound
      .map((row) => row.counterparty)
      .filter((cp): cp is string => cp != null && cp !== '')
      .map((cp) => normalizeAddress(cp, chain)),
  );

  // Coverage reads how well payees are extracted for this wallet, so it counts
  // ROWS (including the null ones), not the deduplicated payee set.
  const withPayee = outbound.filter((row) => row.counterparty != null && row.counterparty !== '').length;
  const coverage = outbound.length > 0 ? withPayee / outbound.length : 0;

  let inboundTotal = 0;
  let reciprocalTotal = 0;
  let payerCount = 0;
  let reciprocalPayerCount = 0;

  for (const row of inbound) {
    const amount = usableAmount(row.total);
    if (amount === 0) continue;
    payerCount += 1;
    inboundTotal += amount;
    if (payees.has(normalizeAddress(row.payer, chain))) {
      reciprocalPayerCount += 1;
      reciprocalTotal += amount;
    }
  }

  const base = { inboundTotal, reciprocalTotal, payerCount, reciprocalPayerCount, coverage };

  if (outbound.length === 0 || coverage < COVERAGE_FLOOR || inboundTotal === 0) {
    return { ...base, ...UNDECIDABLE };
  }

  const reciprocalShare = reciprocalTotal / inboundTotal;
  return {
    ...base,
    reciprocalShare,
    independentShare: 1 - reciprocalShare,
    verdict: verdictFor(reciprocalShare),
  };
}

/**
 * The fields a human-readable line needs. Both {@link ReciprocityResult} and the
 * API's `IndependenceBlock` satisfy it, so neither side has to fabricate the
 * other's shape just to render a sentence.
 */
export type ReciprocitySummary = Pick<
  ReciprocityResult,
  'verdict' | 'coverage' | 'reciprocalShare' | 'reciprocalPayerCount' | 'payerCount'
>;

/**
 * One-line human reading for the `explain` array on the karma response.
 * Returns null when there is nothing worth saying.
 */
export function explainReciprocity(r: ReciprocitySummary): string | null {
  if (r.verdict === 'insufficient-data') {
    // Distinguish "we can't see payees" from "there is no revenue here" —
    // only the first is worth a line; the second says itself elsewhere.
    return r.coverage < COVERAGE_FLOOR && r.payerCount > 0
      ? 'revenue independence unknown \u2014 payee data is missing for most of this wallet\u2019s payments'
      : null;
  }
  if (r.reciprocalPayerCount === 0) {
    return `none of the inbound value came from addresses this wallet also pays (${r.payerCount} payers)`;
  }
  const pct = Math.round(r.reciprocalShare! * 100);
  const addr = r.reciprocalPayerCount === 1 ? 'address' : 'addresses';
  return `${pct}% of inbound value came from ${r.reciprocalPayerCount} ${addr} this wallet also pays`;
}
