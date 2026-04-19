import { NextRequest, NextResponse } from 'next/server';
import { getAllTransactions, getTransactions, upsertWallet, insertScoreSnapshot, getFeedbackSummary, getLatestSignalValues, insertSignalEvents } from '@/db/client';
import { calculateScore, calculateScores } from '@/scoring/index';
import { readAttestation, readAttestations } from '@/integrations/attestation';
import { computeCadence } from '@/scoring/cadence';
import { buildCadenceSignal } from '@/scoring/signals';
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

    const [attestation, feedback, manifestMap] = await Promise.all([
      readAttestation(wallet),
      getFeedbackSummary(wallet),
      getLatestSignalValues([wallet], 'manifest'),
    ]);

    // Recompute + re-emit cadence for this wallet, then use its automationScore.
    const cadence = computeCadence(transactions.map((tx) => new Date(tx.timestamp)));
    if (cadence) {
      await insertSignalEvents([buildCadenceSignal(wallet, cadence)], { overwrite: true });
    }

    const score = calculateScore(
      transactions,
      attestation,
      feedback.deliveryRate,
      feedback.total,
      cadence?.automationScore ?? null,
      manifestMap.get(wallet) ?? null,
    );
    await upsertWallet(wallet, score.score, score.trustTier, score.txCount, {
      providerScore: score.providerScore,
      consumerScore: score.consumerScore,
      confidenceBadge: score.confidenceBadge,
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

  const allTx = await getAllTransactions();
  const walletAddresses = [...new Set(allTx.map((tx) => tx.wallet_address))];
  const attestations = await readAttestations(walletAddresses);

  // Fetch feedback summaries for all wallets
  const feedbackMap = new Map<string, { deliveryRate: number; total: number }>();
  for (const addr of walletAddresses) {
    try {
      const fb = await getFeedbackSummary(addr);
      if (fb.total > 0) feedbackMap.set(addr, fb);
    } catch { /* skip */ }
  }

  const [cadenceScores, manifestScores] = await Promise.all([
    getLatestSignalValues(walletAddresses, 'cadence'),
    getLatestSignalValues(walletAddresses, 'manifest'),
  ]);
  const scores = calculateScores(allTx, attestations, cadenceScores, manifestScores);

  let refreshed = 0;
  for (const [address, score] of scores) {
    // Re-calculate with feedback if available
    const fb = feedbackMap.get(address);
    const finalScore = fb
      ? calculateScore(
          allTx.filter((tx) => tx.wallet_address === address),
          attestations.get(address) ?? 0,
          fb.deliveryRate,
          fb.total,
          cadenceScores.get(address) ?? null,
          manifestScores.get(address) ?? null,
        )
      : score;

    await upsertWallet(address, finalScore.score, finalScore.trustTier, finalScore.txCount, {
      providerScore: finalScore.providerScore,
      consumerScore: finalScore.consumerScore,
      confidenceBadge: finalScore.confidenceBadge,
    });
    await insertScoreSnapshot(
      address,
      finalScore.score,
      finalScore.metrics.successRate,
      finalScore.metrics.diversity,
      finalScore.metrics.volume,
      finalScore.metrics.age,
    );
    refreshed++;
  }

  return NextResponse.json({
    refreshed,
    attestationsFound: attestations.size,
    feedbackWallets: feedbackMap.size,
    message: `Refreshed ${refreshed} wallet scores (${attestations.size} with 8004, ${feedbackMap.size} with feedback)`,
  });
}
