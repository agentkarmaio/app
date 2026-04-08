import { USDC_MINT } from '../config/facilitators';
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

export function extractX402Payment(
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
