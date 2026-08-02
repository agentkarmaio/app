import { NextRequest, NextResponse } from 'next/server';
import {
  extractX402Payment,
  type HeliusEnhancedTransaction,
} from '@/indexer/helius';
import {
  enqueueWalletScan,
  getWallet,
  insertTransactions,
  ensureWalletsExist,
  insertSignalEvents,
  markWalletsDirty,
} from '@/db/client';
import { buildX402PaymentSignals } from '@/scoring/signals';
import { ALL_FACILITATOR_ADDRESSES } from '@/config/facilitators';
import { SPECIMEN_ADDRESSES } from '@/config/specimen';
import type { Transaction } from '@/db/schema';
import { verifyHeliusWebhook } from '@/lib/api-auth';

// Webhook hot path is intentionally O(batch-size), not O(wallet-history):
// - parse + extract x402 payments
// - insert missing wallet stubs (FK requirement for transactions.wallet_address)
// - insert transactions (idempotent via tx_signature unique)
// - emit Tier-2 x402 payment signals (one row per tx, no history read)
// - mark affected wallets dirty so the rescore cron recomputes scores
// - enqueue regressive scan for FRESHLY-OBSERVED counterparties (wallets
//   we'd never indexed before this tick) — captures historical activity
//   for new entrants without flooding the queue on every webhook
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
  const ROUTABLE_RECIPIENTS = [...ALL_FACILITATOR_ADDRESSES, ...SPECIMEN_ADDRESSES];
  for (const tx of body) {
    for (const recipient of ROUTABLE_RECIPIENTS) {
      const payment = extractX402Payment(tx, recipient);
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

  // Detect freshly-observed wallets BEFORE the upsert: if `getWallet` returns
  // null, this webhook tick is the first time we've seen the address. We
  // enqueue regressive scans only for these — every-webhook flooding would
  // hammer the queue, and the 24h cooldown inside `enqueueWalletScan` is a
  // backstop, not the primary gate.
  const preExistence = await Promise.all(
    uniqueWallets.map(async (addr) => ({ addr, existed: (await getWallet(addr)) !== null })),
  );
  const freshWallets = preExistence.filter((w) => !w.existed).map((w) => w.addr);

  // Create missing wallet rows before FK-constrained tx inserts. Insert-if-
  // absent: existing rows (and their live scores) are never touched here —
  // brand-new wallets sit at schema defaults until the rescore cron picks
  // them up.
  await ensureWalletsExist(uniqueWallets);

  const inserted = await insertTransactions(parsed);
  await insertSignalEvents(buildX402PaymentSignals(parsed));
  await markWalletsDirty(uniqueWallets);

  // Fire-and-forget regressive scan enqueue for fresh wallets. Bounded by
  // `freshWallets.length` (≤ unique counterparties in this batch). Each call
  // is internally idempotent. We still gather via `allSettled` so a single
  // failure doesn't sink the rest, and we log them without surfacing to the
  // webhook caller (Helius doesn't need to know about scan-queue health).
  let scansEnqueued = 0;
  if (freshWallets.length > 0) {
    const results = await Promise.allSettled(
      freshWallets.map((addr) => enqueueWalletScan(addr)),
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'rejected') {
        console.error(`[webhook] enqueueWalletScan failed for ${freshWallets[i]}:`, r.reason);
      } else if (r.value.enqueued) {
        scansEnqueued++;
      }
    }
  }

  return NextResponse.json({
    processed: body.length,
    inserted,
    dirty: uniqueWallets.length,
    scansEnqueued,
  });
}
