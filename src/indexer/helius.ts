import { Connection, type ParsedTransactionWithMeta } from '@solana/web3.js';
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

// ─── RPC resolver ────────────────────────────────────────────────────────────

const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

/**
 * RPC endpoint for indexer READS (getSignaturesForAddress + getParsedTransactions).
 * Prefers SOLANA_RPC_URL — set it to a free standard RPC so indexing spends ZERO
 * Helius credits (Helius stays reserved for the push webhook only). Falls back to
 * HELIUS_RPC_URL, then public mainnet-beta. Setting SOLANA_RPC_URL is what makes
 * Solana ingestion fully independent of the Helius quota.
 */
export function getIndexerRpcUrl(): string {
  return process.env.SOLANA_RPC_URL ?? process.env.HELIUS_RPC_URL ?? DEFAULT_RPC;
}

let _rpcConn: Connection | null = null;
function getRpcConnection(): Connection {
  if (!_rpcConn) _rpcConn = new Connection(getIndexerRpcUrl(), 'confirmed');
  return _rpcConn;
}

// ─── Parse (standard RPC — no Helius Enhanced API) ───────────────────────────

/** Concurrent single-tx fetches. We do NOT use batched getParsedTransactions:
 *  free RPCs cap JSON-RPC batch size (PublicNode allows 1 getTransaction/batch),
 *  so we fan out singular getParsedTransaction calls under bounded concurrency. */
const PARSE_CONCURRENCY = 5;

/**
 * Pure: map a standard `getParsedTransaction` result into the
 * HeliusEnhancedTransaction shape the extractors consume. SPL movement (incl.
 * USDC) is reconstructed from `meta.pre/postTokenBalances` deltas — the same
 * decode proven in scripts/test-facilitator.ts. Returns null when the tx has no
 * meta. Zero blast radius: extractX402Payment / extractPayshPayment keep working
 * unchanged off the derived `tokenTransfers` + `accountData`.
 */
export function mapParsedTxToEnhanced(
  tx: ParsedTransactionWithMeta,
  signature: string,
): HeliusEnhancedTransaction | null {
  const meta = tx.meta;
  if (!meta) return null;

  const accountKeys = tx.transaction.message.accountKeys;
  const keyAt = (i: number): string => accountKeys[i]?.pubkey?.toString() ?? '';

  const pre = meta.preTokenBalances ?? [];
  const post = meta.postTokenBalances ?? [];

  // Per token-account (accountIndex) raw signed delta.
  interface Delta { userAccount: string; tokenAccount: string; mint: string; raw: bigint; decimals: number; }
  const deltas: Delta[] = [];
  const indices = new Set<number>([...pre, ...post].map((b) => b.accountIndex));
  for (const idx of indices) {
    const p = pre.find((b) => b.accountIndex === idx);
    const q = post.find((b) => b.accountIndex === idx);
    const mint = q?.mint ?? p?.mint;
    if (!mint) continue;
    const raw = BigInt(q?.uiTokenAmount.amount ?? '0') - BigInt(p?.uiTokenAmount.amount ?? '0');
    if (raw === BigInt(0)) continue;
    deltas.push({
      userAccount: q?.owner ?? p?.owner ?? '',
      tokenAccount: keyAt(idx),
      mint,
      raw,
      decimals: q?.uiTokenAmount.decimals ?? p?.uiTokenAmount.decimals ?? 0,
    });
  }

  // accountData.tokenBalanceChanges — extractor Strategy 2 input.
  const accountData = deltas.map((d) => ({
    account: d.userAccount,
    nativeBalanceChange: 0,
    tokenBalanceChanges: [{
      userAccount: d.userAccount,
      tokenAccount: d.tokenAccount,
      mint: d.mint,
      rawTokenAmount: { tokenAmount: d.raw.toString(), decimals: d.decimals },
    }],
  }));

  // tokenTransfers — extractor Strategy 1 input. Pair each receiver (raw>0) with
  // the largest sender (most-negative raw) of the same mint: covers the simple
  // payer→payee x402 transfer; multi-party splits still yield the dominant move.
  const tokenTransfers: HeliusTokenTransfer[] = [];
  const byMint = new Map<string, Delta[]>();
  for (const d of deltas) {
    const list = byMint.get(d.mint) ?? [];
    list.push(d);
    byMint.set(d.mint, list);
  }
  for (const [mint, list] of byMint) {
    const sender = list.filter((d) => d.raw < BigInt(0)).sort((a, b) => (a.raw < b.raw ? -1 : 1))[0];
    for (const r of list) {
      if (r.raw <= BigInt(0)) continue;
      tokenTransfers.push({
        fromUserAccount: sender?.userAccount ?? '',
        toUserAccount: r.userAccount,
        fromTokenAccount: sender?.tokenAccount ?? '',
        toTokenAccount: r.tokenAccount,
        tokenAmount: Number(r.raw) / 10 ** r.decimals,
        mint,
        tokenStandard: 'Fungible',
      });
    }
  }

  return {
    description: '',
    type: 'UNKNOWN',
    source: 'RPC',
    fee: meta.fee ?? 0,
    feePayer: keyAt(0),
    signature,
    slot: tx.slot,
    timestamp: tx.blockTime ?? 0,
    nativeTransfers: [],
    tokenTransfers,
    accountData,
    transactionError: meta.err ? (typeof meta.err === 'string' ? meta.err : JSON.stringify(meta.err)) : null,
    events: {},
  };
}

/**
 * Fetch + decode transactions via standard-RPC `getParsedTransaction` (singular,
 * concurrent). Replaces the credit-heavy Helius Enhanced Transactions API — runs
 * on whatever getIndexerRpcUrl() resolves to (set SOLANA_RPC_URL to a free RPC
 * for $0/mo). Order is preserved so signatures[i] maps to results' i-th tx.
 */
export async function parseTransactionsBatch(
  signatures: string[],
): Promise<HeliusEnhancedTransaction[]> {
  if (signatures.length === 0) return [];

  const connection = getRpcConnection();
  const parsed = await withConcurrency(signatures, PARSE_CONCURRENCY, async (sig) => {
    try {
      return await connection.getParsedTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
    } catch (err) {
      console.error(`[rpc] getParsedTransaction failed ${sig.slice(0, 12)}…:`, err instanceof Error ? err.message.slice(0, 100) : err);
      return null;
    }
  });

  const results: HeliusEnhancedTransaction[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const tx = parsed[i];
    if (!tx) continue;
    const mapped = mapParsedTxToEnhanced(tx, signatures[i]);
    if (mapped) results.push(mapped);
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
      chain: 'solana',
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
        chain: 'solana',
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
