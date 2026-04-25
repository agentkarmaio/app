import { NextRequest, NextResponse } from 'next/server';
import {
  extractX402Payment,
  type HeliusEnhancedTransaction,
} from '@/indexer/helius';
import {
  insertTransactions,
  upsertWallet,
  insertSignalEvents,
  markWalletsDirty,
} from '@/db/client';
import { buildX402PaymentSignals } from '@/scoring/signals';
import { ALL_FACILITATOR_ADDRESSES } from '@/config/facilitators';
import type { Transaction } from '@/db/schema';
import { verifyHeliusWebhook } from '@/lib/api-auth';

// Webhook hot path is intentionally O(batch-size), not O(wallet-history):
// - parse + extract x402 payments
// - upsert wallet stubs (FK requirement for transactions.wallet_address)
// - insert transactions (idempotent via tx_signature unique)
// - emit Tier-2 x402 payment signals (one row per tx, no history read)
// - mark affected wallets dirty so the rescore cron recomputes scores
//
// Previously this handler re-fetched every tx for each affected wallet and
// recomputed cadence/autonomy/score inline. With 20k+ txs/day, that path
// hit Postgres statement_timeouts, produced 100% webhook failures, and
// caused Helius to auto-disable the webhook on 2026-04-23. See
// `src/scripts/rescore-dirty.ts` for the deferred scoring worker.

export async function POST(request: NextRequest) {
  const auth = verifyHeliusWebhook(request);
  if (!auth.ok) return auth.response;

  let body: HeliusEnhancedTransaction[];
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!Array.isArray(body)) {
    return NextResponse.json({ error: 'Expected array of transactions' }, { status: 400 });
  }

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
    return NextResponse.json({ processed: body.length, inserted: 0, dirty: 0 });
  }

  const uniqueWallets = [...new Set(parsed.map((p) => p.wallet_address))];

  // Create wallet rows before FK-constrained tx inserts. Score/tier stay at
  // their defaults for brand-new wallets until the rescore cron picks them up.
  await Promise.all(
    uniqueWallets.map((addr) => upsertWallet(addr, 0, 'Unrated', 0)),
  );

  const inserted = await insertTransactions(parsed);
  await insertSignalEvents(buildX402PaymentSignals(parsed));
  await markWalletsDirty(uniqueWallets);

  return NextResponse.json({
    processed: body.length,
    inserted,
    dirty: uniqueWallets.length,
  });
}
