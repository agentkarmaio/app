import { NextRequest, NextResponse } from 'next/server';
import { getAllTransactions, getTransactions, upsertWallet, insertScoreSnapshot, getFeedbackSummary, getLatestSignalValues, insertSignalEvents } from '@/db/client';
import { calculateScore, calculateScores } from '@/scoring/index';
import { readAttestation, readAttestations } from '@/integrations/attestation';
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

    const [attestation, feedback, manifestMap] = await Promise.all([
      readAttestation(wallet),
      getFeedbackSummary(wallet),
      getLatestSignalValues([wallet], 'manifest'),
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

  // Group tx by wallet once for autonomy compute + feedback recalc.
  const txByWallet = new Map<string, typeof allTx>();
  for (const tx of allTx) {
    const list = txByWallet.get(tx.wallet_address) ?? [];
    list.push(tx);
    txByWallet.set(tx.wallet_address, list);
  }

  const autonomySignals: ReturnType<typeof buildAutonomySignal>[] = [];
  const autonomyByWallet = new Map<string, ReturnType<typeof computeAutonomy>>();
  for (const [address, txs] of txByWallet) {
    const autonomy = computeAutonomy(
      txs.map((tx) => ({ timestamp: tx.timestamp, counterparty: tx.facilitator })),
    );
    autonomyByWallet.set(address, autonomy);
    if (autonomy) autonomySignals.push(buildAutonomySignal(address, autonomy));
  }
  if (autonomySignals.length > 0) {
    await insertSignalEvents(autonomySignals, { overwrite: true });
  }

  let refreshed = 0;
  for (const [address, score] of scores) {
    const fb = feedbackMap.get(address);
    const finalScore = fb
      ? calculateScore(
          txByWallet.get(address) ?? [],
          attestations.get(address) ?? 0,
          fb.deliveryRate,
          fb.total,
          cadenceScores.get(address) ?? null,
          manifestScores.get(address) ?? null,
        )
      : score;

    const autonomy = autonomyByWallet.get(address);
    await upsertWallet(address, finalScore.score, finalScore.trustTier, finalScore.txCount, {
      providerScore: finalScore.providerScore,
      consumerScore: finalScore.consumerScore,
      confidenceBadge: finalScore.confidenceBadge,
      autonomyScore: autonomy?.score ?? null,
      autonomyLabel: autonomy?.label ?? null,
      metricSuccessRate: finalScore.metrics.successRate,
      metricDiversity:   finalScore.metrics.diversity,
      metricVolume:      finalScore.metrics.volume,
      metricAge:         finalScore.metrics.age,
      metricCadence:     finalScore.metrics.cadence,
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
