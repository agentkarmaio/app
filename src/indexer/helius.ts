import { USDC_MINT } from '../config/facilitators';
import { detectPayshRouted } from './paysh-fingerprint';
import type { Transaction } from '../db/schema';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HeliusTokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  fromTokenAccount: string;
  toTokenAccount: string;
  tokenAmount: number;
  mint: string;
  tokenStandard: string;
}

export interface HeliusEnhancedTransaction {
  description: string;
  type: string;
  source: string;
  fee: number;
  feePayer: string;
  signature: string;
  slot: number;
  timestamp: number;
  nativeTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
  tokenTransfers: HeliusTokenTransfer[];
  accountData: Array<{
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges: Array<{
      userAccount: string;
      tokenAccount: string;
      mint: string;
      rawTokenAmount: { tokenAmount: string; decimals: number };
    }>;
  }>;
  transactionError: string | null;
  events: Record<string, unknown>;
}

// ─── API Key ─────────────────────────────────────────────────────────────────

export function getHeliusApiKey(): string {
  const url = process.env.HELIUS_RPC_URL;
  if (!url) throw new Error('HELIUS_RPC_URL env var is not set');

  const match = url.match(/api-key=([^&]+)/);
  if (!match?.[1]) throw new Error('HELIUS_RPC_URL does not contain an api-key parameter');

  return match[1];
}

// ─── Batch Parse ─────────────────────────────────────────────────────────────

const HELIUS_PARSE_URL = 'https://api-mainnet.helius-rpc.com/v0/transactions';
const MAX_BATCH_SIZE = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export async function parseTransactionsBatch(
  signatures: string[],
): Promise<HeliusEnhancedTransaction[]> {
  if (signatures.length === 0) return [];

  const apiKey = getHeliusApiKey();
  const url = `${HELIUS_PARSE_URL}?api-key=${apiKey}`;
  const chunks = chunk(signatures, MAX_BATCH_SIZE);
  const results: HeliusEnhancedTransaction[] = [];

  for (const batch of chunks) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: batch }),
      });

      if (!res.ok) {
        console.error(
          `[helius] parseTransactions failed: ${res.status} ${res.statusText} (batch of ${batch.length})`,
        );
        continue;
      }

      const data = (await res.json()) as HeliusEnhancedTransaction[];
      results.push(...data);
    } catch (err) {
      console.error(`[helius] parseTransactions network error (batch of ${batch.length}):`, err);
    }
  }

  return results;
}

// ─── Payment Extraction ──────────────────────────────────────────────────────

/**
 * Core extraction. Given a parsed tx and a known facilitator address, return
 * the USDC payment (payer wallet + amount) flowing into that facilitator, or
 * null if the tx is not an x402 payment to this facilitator.
 *
 * Both public wrappers — facilitator-keyed and wallet-keyed — delegate here.
 */
function extractX402PaymentCore(
  tx: HeliusEnhancedTransaction,
  facilitatorAddress: string,
): Omit<Transaction, 'id'> | null {
  const success = tx.transactionError === null;
  const timestamp = new Date(tx.timestamp * 1000).toISOString();

  // Strategy 1: tokenTransfers — find the USDC transfer where the sender is NOT the facilitator
  const usdcTransfers = tx.tokenTransfers.filter((t) => t.mint === USDC_MINT);

  const payerTransfer = usdcTransfers.find(
    (t) => t.fromUserAccount !== facilitatorAddress,
  );

  if (payerTransfer && payerTransfer.tokenAmount > 0) {
    return {
      wallet_address: payerTransfer.fromUserAccount,
      facilitator: facilitatorAddress,
      amount: payerTransfer.tokenAmount,
      timestamp,
      success,
      tx_signature: tx.signature,
    };
  }

  // Strategy 2: accountData tokenBalanceChanges — look for USDC balance decrease
  for (const entry of tx.accountData) {
    for (const change of entry.tokenBalanceChanges) {
      if (change.mint !== USDC_MINT) continue;

      const raw = parseFloat(change.rawTokenAmount.tokenAmount);
      const decimals = change.rawTokenAmount.decimals;

      // Negative raw amount means tokens left the account
      if (raw >= 0) continue;
      if (change.userAccount === facilitatorAddress) continue;

      const amount = Math.abs(raw) / 10 ** decimals;
      if (amount <= 0) continue;

      return {
        wallet_address: change.userAccount,
        facilitator: facilitatorAddress,
        amount,
        timestamp,
        success,
        tx_signature: tx.signature,
      };
    }
  }

  return null;
}

/**
 * Facilitator-keyed extractor. Used by the original facilitator-side indexer
 * pass: we already know the facilitator we're scanning, so we only need to
 * find the payer side of the USDC transfer.
 */
export function extractX402Payment(
  tx: HeliusEnhancedTransaction,
  facilitatorAddress: string,
): Omit<Transaction, 'id'> | null {
  return extractX402PaymentCore(tx, facilitatorAddress);
}

/**
 * Wallet-keyed extractor. Used by the regressive wallet-history scan: we are
 * iterating signatures for `wallet` and need to discover, on each tx, whether
 * the *counterparty* is a known x402 facilitator.
 *
 * Algorithm:
 *  1. Skip failed txs — only successful settlements count as receipts.
 *  2. Strategy A: scan USDC token transfers. If wallet is the sender and the
 *     recipient is in the facilitator set, we have a hit.
 *  3. Strategy B: same logic over `accountData.tokenBalanceChanges` for
 *     edge cases where Helius drops the typed view.
 *  4. Resolve the facilitator address, delegate to the core extractor for
 *     row construction, then verify the wallet matches (defensive sanity
 *     check — if the core extractor inferred a different payer, drop the hit).
 */
export function extractX402PaymentForWallet(
  tx: HeliusEnhancedTransaction,
  wallet: string,
  facilitatorSet: ReadonlySet<string>,
): { facilitator: string; payment: Omit<Transaction, 'id'> } | null {
  if (tx.transactionError !== null) return null;

  let facilitator: string | null = null;

  // Strategy A: USDC token transfers where wallet → facilitator.
  for (const t of tx.tokenTransfers ?? []) {
    if (t.mint !== USDC_MINT) continue;
    if (t.tokenAmount <= 0) continue;
    if (t.fromUserAccount !== wallet) continue;
    if (!facilitatorSet.has(t.toUserAccount)) continue;
    facilitator = t.toUserAccount;
    break;
  }

  // Strategy B: balance-change view. Find a USDC change where wallet decreases
  // and another USDC change where a facilitator account increases, in the same tx.
  if (!facilitator) {
    let walletDebited = false;
    let facilitatorCredited: string | null = null;
    for (const entry of tx.accountData ?? []) {
      for (const change of entry.tokenBalanceChanges ?? []) {
        if (change.mint !== USDC_MINT) continue;
        const raw = parseFloat(change.rawTokenAmount.tokenAmount);
        if (!Number.isFinite(raw) || raw === 0) continue;
        if (raw < 0 && change.userAccount === wallet) walletDebited = true;
        if (raw > 0 && facilitatorSet.has(change.userAccount)) {
          facilitatorCredited = change.userAccount;
        }
      }
    }
    if (walletDebited && facilitatorCredited) facilitator = facilitatorCredited;
  }

  if (!facilitator) return null;

  const payment = extractX402PaymentCore(tx, facilitator);
  if (!payment) return null;
  // Defensive: ensure the inferred payer matches the wallet under scan.
  if (payment.wallet_address !== wallet) return null;

  return { facilitator, payment };
}

// ─── pay.sh Detection (sprint A1) ────────────────────────────────────────────


/**
 * Wrapper: classifies a parsed Helius tx as pay.sh-routed and, when it is,
 * extracts the payer wallet so the indexer can emit a `paysh_routed`
 * Tier 1 signal_event.
 *
 * The payer wallet identification reuses the same heuristic as
 * extractX402Payment: the source of the largest non-operator token transfer
 * is the agent making the payment. Falls back to the first signer when
 * tokenTransfers is empty (Token-2022 with extensions occasionally lacks
 * the typed view in Helius output).
 */
export interface PayshExtractedPayment {
  wallet: string;
  operatorAddress: string;
  operatorId: string;
  protocol: 'x402' | 'mpp' | 'hybrid';
  txSignature: string;
  observedAt: string;
}

export function extractPayshPayment(
  tx: HeliusEnhancedTransaction,
): PayshExtractedPayment | null {
  const det = detectPayshRouted(tx);
  if (!det.isPaysh || !det.operator || !det.operatorId || !det.protocol) return null;

  // Identify payer wallet: the source of the first token transfer NOT going
  // to the operator address. Skip transfers where source == operator (those
  // are the operator/platform fee splits, not the user payment).
  const knownOperatorAddrs = new Set<string>();
  knownOperatorAddrs.add(det.operator);
  let payer: string | null = null;
  for (const t of tx.tokenTransfers ?? []) {
    if (!t.fromUserAccount) continue;
    if (knownOperatorAddrs.has(t.fromUserAccount)) continue;
    if (t.fromUserAccount === tx.feePayer) continue; // sponsored gas keypair
    payer = t.fromUserAccount;
    break;
  }
  // Fallback: balance-change negative on a non-operator account.
  if (!payer) {
    for (const entry of tx.accountData ?? []) {
      for (const change of entry.tokenBalanceChanges ?? []) {
        const raw = parseFloat(change.rawTokenAmount.tokenAmount);
        if (!Number.isFinite(raw) || raw >= 0) continue;
        if (knownOperatorAddrs.has(change.userAccount)) continue;
        if (change.userAccount === tx.feePayer) continue;
        payer = change.userAccount;
        break;
      }
      if (payer) break;
    }
  }
  if (!payer) return null;

  return {
    wallet: payer,
    operatorAddress: det.operator,
    operatorId: det.operatorId,
    protocol: det.protocol,
    txSignature: tx.signature,
    observedAt: new Date(tx.timestamp * 1000).toISOString(),
  };
}

// ─── Concurrency Pool ────────────────────────────────────────────────────────

export async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);

  return results;
}
