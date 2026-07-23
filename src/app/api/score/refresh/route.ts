import { NextRequest, NextResponse } from 'next/server';
import { getTransactions, upsertWallet, insertScoreSnapshot, getFeedbackSummary, getLatestSignalValues, getSignalEventsForWallet, insertSignalEvents, markAllWalletsDirty } from '@/db/client';
import { calculateScore } from '@/scoring/index';
import { readAttestation } from '@/integrations/attestation';
import { computeCadence } from '@/scoring/cadence';
import { computeAutonomy } from '@/scoring/autonomy';
import { buildCadenceSignal, buildAutonomySignal } from '@/scoring/signals';
import { requireBearerSecret } from '@/lib/api-auth';
import { enforceRateLimit } from '@/lib/rate-limit';

export async function POST(request: NextRequest) {
  const auth = requireBearerSecret(request, 'SCORE_REFRESH_TOKEN');
  if (!auth.ok) return auth.response;

  const gate = await enforceRateLimit('score-refresh', request);
  if (!gate.ok) return gate.response;

  const body = await request.json().catch(() => ({}));
  const wallet = (body as { wallet?: string }).wallet;

  if (wallet) {
    const transactions = await getTransactions(wallet, 10000);
    if (transactions.length === 0) {
      return NextResponse.json({ error: 'No transactions found for wallet' }, { status: 404 });
    }

    const [attestation, feedback, manifestMap, signalEvents] = await Promise.all([
      readAttestation(wallet),
      getFeedbackSummary(wallet),
      getLatestSignalValues([wallet], 'manifest'),
      getSignalEventsForWallet(wallet, 200).catch(() => []),
    ]);

    // Recompute + re-emit cadence + autonomy for this wallet.
    const cadence = computeCadence(transactions.map((tx) => new Date(tx.timestamp)));
    if (cadence) {
      await insertSignalEvents([buildCadenceSignal(wallet, cadence)], { overwrite: true });
    }
    const autonomy = computeAutonomy(
      transactions.map((tx) => ({ timestamp: tx.timestamp, counterparty: tx.facilitator })),
    );
    if (autonomy) {
      await insertSignalEvents([buildAutonomySignal(wallet, autonomy)], { overwrite: true });
    }

    const score = calculateScore(
      transactions,
      attestation,
      feedback.deliveryRate,
      feedback.total,
      cadence?.automationScore ?? null,
      manifestMap.get(wallet) ?? null,
      null,
      signalEvents,
    );
    await upsertWallet(wallet, score.score, score.trustTier, score.txCount, {
      providerScore: score.providerScore,
      consumerScore: score.consumerScore,
      confidenceBadge: score.confidenceBadge,
      autonomyScore: autonomy?.score ?? null,
      autonomyLabel: autonomy?.label ?? null,
      metricSuccessRate: score.metrics.successRate,
      metricDiversity:   score.metrics.diversity,
      metricVolume:      score.metrics.volume,
      metricAge:         score.metrics.age,
      metricCadence:     score.metrics.cadence,
    });
    await insertScoreSnapshot(
      wallet,
      score.score,
      score.metrics.successRate,
      score.metrics.diversity,
      score.metrics.volume,
      score.metrics.age,
    );

    return NextResponse.json({ refreshed: 1, wallet: score, feedbackCount: feedback.total });
  }

  // No wallet → full rescore. This ENQUEUES rather than scoring inline: the old
  // inline version read every transaction into memory, then looped feedback +
  // upsert + snapshot over ~105k wallets one at a time (~315k sequential round
  // trips), which cannot complete inside a request. Marking every wallet dirty
  // is one statement; the scoring worker drains the queue at its own bounded
  // rate with a bounded per-wallet window.
  const queued = await markAllWalletsDirty();

  return NextResponse.json({
    queued,
    message:
      `Queued ${queued} wallets for rescoring. Scoring runs in the background ` +
      '(scoring worker / POST /api/cron/rescore); this endpoint no longer scores inline.',
  });
}
