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

/** Extract USDC payment from a parsed x402 transaction.
 *
 * x402 pattern: facilitator is the tx signer (accountKeys[0]).
 * USDC transfer is a `transferChecked` instruction with:
 *   - authority = agent wallet (sender)
 *   - mint = USDC
 *   - tokenAmount = payment amount
 *
 * Fallback: if no instruction match, check token balance diffs.
 */
export function parseX402Transaction(
  tx: ParsedTransactionWithMeta,
  facilitatorAddress: string
): Omit<Transaction, 'id'> | null {
  if (!tx.blockTime || !tx.transaction) return null;
  if (!tx.meta) return null;

  const signature = tx.transaction.signatures[0];
  const success = tx.meta.err === null;
  const timestamp = new Date(tx.blockTime * 1000).toISOString();

  // Strategy 1: Look for USDC transferChecked in top-level + inner instructions
  const allInstructions = [
    ...tx.transaction.message.instructions,
    ...(tx.meta.innerInstructions ?? []).flatMap((g) => g.instructions),
  ];

  for (const ix of allInstructions) {
    if (!('parsed' in ix) || !ix.parsed || typeof ix.parsed !== 'object') continue;

    const parsed = ix.parsed as { type?: string; info?: Record<string, unknown> };
    if (parsed.type !== 'transfer' && parsed.type !== 'transferChecked') continue;

    const info = parsed.info;
    if (!info) continue;

    const mint = info.mint as string | undefined;
    const authority = info.authority as string | undefined;

    // For transferChecked, mint is explicit. For transfer, check via token balances.
    if (parsed.type === 'transferChecked' && mint !== USDC_MINT) continue;

    const tokenAmount = info.tokenAmount as { uiAmount?: number } | undefined;
    const rawAmount = info.amount as string | undefined;

    let amount = 0;
    if (tokenAmount?.uiAmount) {
      amount = tokenAmount.uiAmount;
    } else if (rawAmount && parsed.type === 'transferChecked') {
      amount = parseInt(rawAmount, 10) / 1_000_000; // USDC has 6 decimals
    }

    if (amount <= 0 || !authority) continue;

    // For plain 'transfer' (no mint field), verify it's USDC via token balance mints
    if (parsed.type === 'transfer') {
      const postBalances = tx.meta?.postTokenBalances ?? [];
      const source = info.source as string | undefined;
      const sourceBalance = postBalances.find(
        (b) => {
          const accountKeys = tx.transaction.message.accountKeys;
          const key = typeof accountKeys[b.accountIndex] === 'string'
            ? accountKeys[b.accountIndex]
            : (accountKeys[b.accountIndex] as { pubkey: PublicKey }).pubkey.toBase58();
          return key === source;
        }
      );
      if (!sourceBalance || sourceBalance.mint !== USDC_MINT) continue;
      amount = parseInt(rawAmount ?? '0', 10) / 1_000_000;
    }

    return {
      wallet_address: authority,
      facilitator: facilitatorAddress,
      amount,
      timestamp,
      success,
      tx_signature: signature,
    };
  }

  // Strategy 2: Fallback — check USDC balance diffs
  const pre = tx.meta.preTokenBalances ?? [];
  const post = tx.meta.postTokenBalances ?? [];

  let senderAddress: string | null = null;
  let transferAmount = 0;

  for (const postBal of post) {
    if (postBal.mint !== USDC_MINT) continue;
    const preBal = pre.find((p) => p.accountIndex === postBal.accountIndex);
    const preAmt = preBal?.uiTokenAmount.uiAmount ?? 0;
    const postAmt = postBal.uiTokenAmount.uiAmount ?? 0;
    const delta = postAmt - preAmt;

    if (delta < 0 && postBal.owner) {
      senderAddress = postBal.owner;
      transferAmount = Math.abs(delta);
      break;
    }
  }

  if (!senderAddress || transferAmount <= 0) return null;

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

  // Ensure wallet records exist before inserting transactions (FK constraint)
  const uniqueWallets = [...new Set(transactions.map((tx) => tx.wallet_address))];
  console.log(`[indexer] Creating ${uniqueWallets.length} wallet records...`);
  for (const addr of uniqueWallets) {
    await upsertWallet(addr, 0, 'Unrated', 0);
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
