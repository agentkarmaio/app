/**
 * Karma Indexer — Fetches x402 USDC payment transactions from Solana
 * for all known facilitator addresses using the Solana RPC API.
 *
 * Env:
 *   SOLANA_RPC_URL — Helius/Shyft/custom endpoint (falls back to public mainnet)
 */

import {
  Connection,
  PublicKey,
} from '@solana/web3.js';
import type {
  ParsedTransactionWithMeta,
  ConfirmedSignatureInfo,
} from '@solana/web3.js';
import {
  ALL_FACILITATOR_ADDRESSES,
  USDC_MINT,
  getFacilitatorName,
} from '../config/facilitators';
import type { Transaction } from '../db/schema';
import { insertTransactions, upsertWallet, insertScoreSnapshot } from '../db/client';
import { calculateScores } from '../scoring';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
const RATE_LIMIT_MS = 200;
const DEFAULT_LIMIT = 100;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getConnection(): Connection {
  const rpcUrl = process.env.HELIUS_RPC_URL ?? process.env.SOLANA_RPC_URL ?? DEFAULT_RPC;
  return new Connection(rpcUrl, 'confirmed');
}

/** Extract USDC token transfer details from a parsed transaction */
export function parseX402Transaction(
  tx: ParsedTransactionWithMeta,
  facilitatorAddress: string
): Omit<Transaction, 'id'> | null {
  if (!tx.blockTime || !tx.transaction) return null;

  const meta = tx.meta;
  if (!meta) return null;

  const signature = tx.transaction.signatures[0];
  const success = meta.err === null;
  const timestamp = new Date(tx.blockTime * 1000).toISOString();

  // Walk through post token balances to find USDC transfers to the facilitator
  const preTokenBalances = meta.preTokenBalances ?? [];
  const postTokenBalances = meta.postTokenBalances ?? [];

  // Build a map of account index → owner for post balances
  const accountKeys = tx.transaction.message.accountKeys.map((k) =>
    typeof k === 'string' ? k : k.pubkey.toBase58()
  );

  // Find USDC accounts owned by the facilitator (receiver) and sender
  let facilitatorPreBalance = 0;
  let facilitatorPostBalance = 0;
  let senderAddress: string | null = null;
  let transferAmount = 0;

  for (const post of postTokenBalances) {
    if (
      post.mint === USDC_MINT &&
      post.owner === facilitatorAddress
    ) {
      facilitatorPostBalance = post.uiTokenAmount.uiAmount ?? 0;
      const pre = preTokenBalances.find((p) => p.accountIndex === post.accountIndex);
      facilitatorPreBalance = pre?.uiTokenAmount.uiAmount ?? 0;
      transferAmount = facilitatorPostBalance - facilitatorPreBalance;
    }
  }

  // If no USDC flow to facilitator detected, skip
  if (transferAmount <= 0) return null;

  // Find the sender: look for USDC account where balance decreased
  for (const pre of preTokenBalances) {
    if (pre.mint !== USDC_MINT) continue;
    const post = postTokenBalances.find((p) => p.accountIndex === pre.accountIndex);
    const preAmt = pre.uiTokenAmount.uiAmount ?? 0;
    const postAmt = post?.uiTokenAmount.uiAmount ?? 0;
    if (preAmt > postAmt && pre.owner) {
      senderAddress = pre.owner;
      break;
    }
  }

  // Fall back to fee payer if we couldn't find a USDC sender
  if (!senderAddress && accountKeys.length > 0) {
    senderAddress = accountKeys[0];
  }

  if (!senderAddress) return null;

  return {
    wallet_address: senderAddress,
    facilitator: facilitatorAddress,
    amount: transferAmount,
    timestamp,
    success,
    tx_signature: signature,
  };
}

/**
 * Fetch and parse x402 transactions for a single facilitator address.
 * Returns an array of Transaction objects (without `id`).
 */
export async function fetchTransactionsForFacilitator(
  address: string,
  limit: number = DEFAULT_LIMIT
): Promise<Omit<Transaction, 'id'>[]> {
  const connection = getConnection();
  const pubkey = new PublicKey(address);

  let signatures: ConfirmedSignatureInfo[];
  try {
    signatures = await connection.getSignaturesForAddress(pubkey, { limit });
  } catch (err) {
    console.error(`[indexer] Failed to get signatures for ${address}:`, err);
    return [];
  }

  const results: Omit<Transaction, 'id'>[] = [];

  for (const sigInfo of signatures) {
    await sleep(RATE_LIMIT_MS);

    let tx: ParsedTransactionWithMeta | null = null;
    try {
      tx = await connection.getParsedTransaction(sigInfo.signature, {
        maxSupportedTransactionVersion: 0,
      });
    } catch (err) {
      console.error(`[indexer] Failed to get tx ${sigInfo.signature}:`, err);
      continue;
    }

    if (!tx) continue;

    const parsed = parseX402Transaction(tx, address);
    if (parsed) {
      results.push(parsed);
    }
  }

  console.log(`[indexer] ${address} (${getFacilitatorName(address) ?? 'unknown'}): ${results.length}/${signatures.length} USDC txs`);
  return results;
}

/**
 * Fetch x402 transactions for ALL known facilitator addresses.
 * Applies rate limiting between each facilitator call.
 */
export async function fetchAllX402Transactions(
  limit: number = DEFAULT_LIMIT
): Promise<Omit<Transaction, 'id'>[]> {
  const all: Omit<Transaction, 'id'>[] = [];

  for (const address of ALL_FACILITATOR_ADDRESSES) {
    const txs = await fetchTransactionsForFacilitator(address, limit);
    all.push(...txs);
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`[indexer] Total x402 transactions fetched: ${all.length}`);
  return all;
}

/**
 * Full indexer run: fetch all x402 transactions, persist to DB,
 * recalculate scores, and update wallet records.
 */
export async function runIndexer(limit: number = DEFAULT_LIMIT): Promise<{
  fetched: number;
  inserted: number;
  scored: number;
}> {
  console.log('[indexer] Starting full indexer run...');

  const transactions = await fetchAllX402Transactions(limit);
  if (transactions.length === 0) {
    console.log('[indexer] No transactions found');
    return { fetched: 0, inserted: 0, scored: 0 };
  }

  const inserted = await insertTransactions(transactions);
  console.log(`[indexer] Inserted ${inserted}/${transactions.length} transactions`);

  const scores = calculateScores(transactions);

  let scored = 0;
  for (const [address, walletScore] of scores) {
    await upsertWallet(address, walletScore.score, walletScore.trustTier, walletScore.txCount);
    await insertScoreSnapshot(
      address,
      walletScore.score,
      walletScore.metrics.successRate,
      walletScore.metrics.diversity,
      walletScore.metrics.volume,
      walletScore.metrics.age,
    );
    scored++;
  }

  console.log(`[indexer] Scored ${scored} wallets`);
  return { fetched: transactions.length, inserted, scored };
}
