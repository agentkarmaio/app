/**
 * The one decoder for "what USDC moved, according to a Horizon record".
 *
 * Horizon renders the same value movement three different ways, and each of the
 * three call sites here got it wrong in its own way before this module existed:
 *
 *   - `indexer/stellar-transfers.ts`  — Tier-1 receipts from seeded accounts
 *   - `indexer/stellar-x402.ts`       — the x402 facilitator Horizon backfill
 *   - `integrations/stellar-flows.ts` — the read-time independence signal
 *
 * A shape that is not decoded means every Soroban settlement silently vanishes;
 * an asset that is not pinned means a stranger's token scores as Circle's. Both
 * failures are invisible — they produce fewer rows, never an error — so the
 * decision lives in exactly one place.
 *
 * Input is `unknown` on purpose: two of the three callers hand over raw Horizon
 * JSON, and one malformed record must not take down a whole read.
 *
 */

/**
 * One entry of `invoke_host_function.asset_balance_changes` — where a Soroban
 * SAC transfer actually lives. The enclosing record carries no from/to, which
 * is why a `type === 'payment'` filter drops every Soroban settlement.
 */
export interface HorizonBalanceChange {
  type: string;
  from?: string;
  to?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
}

/** A record from `GET /accounts/{G…}/payments`. */
export interface HorizonPaymentRecord {
  id: string;
  paging_token: string;
  transaction_successful: boolean;
  source_account: string;
  type: string;
  created_at: string;
  transaction_hash: string;
  // classic payment / path payment
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  source_asset_code?: string;
  source_asset_issuer?: string;
  from?: string;
  to?: string;
  amount?: string;
  // Soroban
  asset_balance_changes?: HorizonBalanceChange[];
}

/** A decoded USDC value movement, independent of which record shape carried it. */
export interface StellarUsdcTransfer {
  from: string;
  to: string;
  amount: number;
  txHash: string;
  pagingToken: string;
  createdAt: string;
  successful: boolean;
}

/** The asset to match, pinned as code + issuer. Never a bare code. */
export interface AssetPin {
  code: string;
  issuer: string;
}

/**
 * The operation types that carry an asset on the record itself.
 *
 * A path payment is matched on its DESTINATION asset: `amount` is the
 * destination amount, so `to` really did receive that much USDC, whatever was
 * sent at the other end.
 */
const CLASSIC_VALUE_OPS: ReadonlySet<string> = new Set([
  'payment',
  'path_payment_strict_send',
  'path_payment_strict_receive',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Horizon amounts are decimal strings ("0.5000000"). Non-finite or ≤ 0 → dropped. */
function usableAmount(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function assetMatches(pin: AssetPin, code: unknown, issuer: unknown): boolean {
  return code === pin.code && issuer === pin.issuer;
}

/**
 * Pure: decode every issuer-pinned USDC transfer carried by one Horizon record.
 *
 * Returns [] for anything else — another asset, a USDC-coded token from another
 * issuer, an op that moves no value, a mint/burn/clawback balance change, a
 * self-movement (see `push` below), or a record that is not shaped like a
 * record at all.
 *
 * A record may legitimately yield SEVERAL transfers: one Soroban invocation can
 * carry multiple legs. Callers persisting to `transactions` must reduce them,
 * because `tx_signature` is globally UNIQUE.
 *
 * Stellar StrKey is case-SENSITIVE. Addresses pass through byte-for-byte; the
 * lowercasing EVM indexers apply would corrupt them.
 */
export function extractUsdcTransfers(record: unknown, pin: AssetPin): StellarUsdcTransfer[] {
  if (!isRecord(record)) return [];

  const base = {
    txHash: str(record.transaction_hash),
    pagingToken: str(record.paging_token),
    createdAt: str(record.created_at),
    // Absent reads as successful (Horizon always sends it); only an explicit
    // false is a failure, so the field can never reach the DB as undefined.
    successful: record.transaction_successful !== false,
  };
  const out: StellarUsdcTransfer[] = [];

  /**
   * A movement needs TWO parties.
   *
   * `from === to` is a self-movement: a strict-send path payment to oneself (how
   * you trade on the Stellar DEX — XLM in, USDC out) or a self-transfer. Real
   * value moves, but nobody paid anybody, and every consumer of this decoder is
   * counterparty-oriented. Kept, it corrupts each of them differently: the
   * independence read credits the account with a payer that IS the account, and
   * the indexers write a row whose counterparty normalizes to null — invisible
   * to the inbound lookup, so the wallet reads as MORE independent than it is.
   *
   * Observed, not theoretical: three DEX self-swaps on mainnet agent GC2NIKT6…
   * moved its live verdict from insufficient-data to independent.
   */
  const push = (from: string, to: string, amount: number): void => {
    if (!from || !to || from === to || amount === 0) return;
    out.push({ from, to, amount, ...base });
  };

  // Soroban: the record itself has no from/to.
  const changes = record.asset_balance_changes;
  if (Array.isArray(changes)) {
    for (const change of changes) {
      if (!isRecord(change)) continue;
      // 'mint' / 'burn' / 'clawback' are asset infrastructure, not a payment
      // between two parties. Counting a mint as inbound would invent a customer.
      if (change.type !== 'transfer') continue;
      if (!assetMatches(pin, change.asset_code, change.asset_issuer)) continue;
      push(str(change.from), str(change.to), usableAmount(change.amount));
    }
  }

  // Classic payment + path payment (destination asset).
  if (CLASSIC_VALUE_OPS.has(str(record.type)) && assetMatches(pin, record.asset_code, record.asset_issuer)) {
    push(str(record.from), str(record.to), usableAmount(record.amount));
  }

  return out;
}
