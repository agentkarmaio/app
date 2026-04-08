import { NextRequest, NextResponse } from 'next/server';
import {
  extractX402Payment,
  type HeliusEnhancedTransaction,
} from '@/indexer/helius';
import {
  insertTransactions,
  upsertWallet,
  getTransactionsForWallets,
  insertScoreSnapshot,
} from '@/db/client';
import { calculateScores } from '@/scoring';
import { readAttestations } from '@/integrations/attestation';
import { ALL_FACILITATOR_ADDRESSES } from '@/config/facilitators';
import type { Transaction } from '@/db/schema';

export async function POST(request: NextRequest) {
  // 1. Auth — validate webhook secret if configured
  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  if (secret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // 2. Parse body — Helius sends an array of enhanced transactions
  let body: HeliusEnhancedTransaction[];
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!Array.isArray(body)) {
    return NextResponse.json({ error: 'Expected array of transactions' }, { status: 400 });
  }

  // 3. Extract x402 payments — try each facilitator address per tx
  const parsed: Omit<Transaction, 'id'>[] = [];

  for (const tx of body) {
    for (const facilitator of ALL_FACILITATOR_ADDRESSES) {
      const payment = extractX402Payment(tx, facilitator);
      if (payment) {
        parsed.push(payment);
        break;
      }
    }
  }

  if (parsed.length === 0) {
    return NextResponse.json({ processed: body.length, inserted: 0, scored: 0 });
  }

  // 4. Ensure wallet records exist for each unique address
  const uniqueWallets = [...new Set(parsed.map((p) => p.wallet_address))];

  await Promise.all(
    uniqueWallets.map((addr) => upsertWallet(addr, 0, 'Unrated', 0)),
  );

  // 5. Insert transactions — idempotent via tx_signature upsert
  const inserted = await insertTransactions(parsed);

  // 6. Re-score affected wallets
  const allTxs = await getTransactionsForWallets(uniqueWallets);
  const attestations = await readAttestations(uniqueWallets);
  const scores = calculateScores(allTxs, attestations);

  await Promise.all(
    [...scores.entries()].map(async ([address, ws]) => {
      await upsertWallet(address, ws.score, ws.trustTier, ws.txCount);
      await insertScoreSnapshot(
        address,
        ws.score,
        ws.metrics.successRate,
        ws.metrics.diversity,
        ws.metrics.volume,
        ws.metrics.age,
      );
    }),
  );

  return NextResponse.json({
    processed: body.length,
    inserted,
    scored: scores.size,
  });
}
