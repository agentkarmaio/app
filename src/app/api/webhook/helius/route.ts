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
  insertSignalEvents,
  getLatestSignalValues,
} from '@/db/client';
import { calculateScores } from '@/scoring';
import { buildX402PaymentSignals, buildCadenceSignal } from '@/scoring/signals';
import { computeCadence } from '@/scoring/cadence';
import { readAttestations } from '@/integrations/attestation';
import { ALL_FACILITATOR_ADDRESSES } from '@/config/facilitators';
import type { Transaction } from '@/db/schema';
import { verifyHeliusWebhook } from '@/lib/api-auth';

export async function POST(request: NextRequest) {
  // 1. Auth — Helius sends the configured Authentication Header verbatim.
  //    Accepts HELIUS_WEBHOOK_AUTH_HEADER or legacy HELIUS_WEBHOOK_SECRET.
  const auth = verifyHeliusWebhook(request);
  if (!auth.ok) return auth.response;

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
  await insertSignalEvents(buildX402PaymentSignals(parsed));

  // 6. Re-score affected wallets
  const allTxs = await getTransactionsForWallets(uniqueWallets);
  const attestations = await readAttestations(uniqueWallets);

  // Recompute + emit cadence, then feed the map into scoring.
  const cadenceByWallet = new Map<string, Date[]>();
  for (const tx of allTxs) {
    const list = cadenceByWallet.get(tx.wallet_address) ?? [];
    list.push(new Date(tx.timestamp));
    cadenceByWallet.set(tx.wallet_address, list);
  }
  const cadenceSignals = [];
  const cadenceScores = new Map<string, number>();
  for (const [addr, ts] of cadenceByWallet) {
    const cadence = computeCadence(ts);
    if (cadence) {
      cadenceSignals.push(buildCadenceSignal(addr, cadence));
      cadenceScores.set(addr, cadence.automationScore);
    }
  }
  if (cadenceSignals.length > 0) {
    await insertSignalEvents(cadenceSignals, { overwrite: true });
  }

  const manifestScores = await getLatestSignalValues(uniqueWallets, 'manifest');
  const scores = calculateScores(allTxs, attestations, cadenceScores, manifestScores);

  await Promise.all(
    [...scores.entries()].map(async ([address, ws]) => {
      await upsertWallet(address, ws.score, ws.trustTier, ws.txCount, {
        providerScore: ws.providerScore,
        consumerScore: ws.consumerScore,
        confidenceBadge: ws.confidenceBadge,
      });
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
