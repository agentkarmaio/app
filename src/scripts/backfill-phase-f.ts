/**
 * Backfill provider_score / consumer_score / confidence_badge on every wallet.
 *
 * Required once after Phase F migration lands. Replays `calculateScore` for
 * every wallet with ≥1 transaction and writes the new Phase F fields via the
 * updated `upsertWallet`. Wallets with zero transactions are left at the
 * default confidence_badge = 'declared'.
 *
 * Usage:
 *   bun run src/scripts/backfill-phase-f.ts
 */

import {
  getAllTransactions, upsertWallet, insertScoreSnapshot, getFeedbackSummary,
  getLatestSignalValues,
} from '../db/client';
import { calculateScore } from '../scoring';
import { computeCadence } from '../scoring/cadence';
import { readAttestations } from '../integrations/attestation';

async function main() {
  console.log('[backfill] Loading all transactions…');
  const allTx = await getAllTransactions();
  const wallets = [...new Set(allTx.map((tx) => tx.wallet_address))];
  console.log(`[backfill] ${allTx.length} tx across ${wallets.length} wallets`);

  console.log('[backfill] Fetching 8004 attestations…');
  const attestations = await readAttestations(wallets);
  console.log(`[backfill] ${attestations.size} wallets have 8004 attestations`);

  console.log('[backfill] Loading manifest signals…');
  const manifestScores = await getLatestSignalValues(wallets, 'manifest');
  console.log(`[backfill] ${manifestScores.size} wallets have a manifest`);

  const txByWallet = new Map<string, typeof allTx>();
  for (const tx of allTx) {
    const list = txByWallet.get(tx.wallet_address) ?? [];
    list.push(tx);
    txByWallet.set(tx.wallet_address, list);
  }

  let done = 0;
  const badgeCounts: Record<string, number> = {};
  for (const wallet of wallets) {
    const txs = txByWallet.get(wallet) ?? [];
    if (txs.length === 0) continue;

    let feedbackRate: number | undefined;
    let feedbackTotal: number | undefined;
    try {
      const fb = await getFeedbackSummary(wallet);
      if (fb.total > 0) {
        feedbackRate = fb.deliveryRate;
        feedbackTotal = fb.total;
      }
    } catch { /* skip */ }

    const cadence = computeCadence(txs.map((tx) => new Date(tx.timestamp)));
    const score = calculateScore(
      txs,
      attestations.get(wallet) ?? 0,
      feedbackRate,
      feedbackTotal,
      cadence?.automationScore ?? null,
      manifestScores.get(wallet) ?? null,
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

    badgeCounts[score.confidenceBadge] = (badgeCounts[score.confidenceBadge] ?? 0) + 1;
    done++;
    if (done % 25 === 0) console.log(`[backfill] ${done}/${wallets.length}`);
  }

  console.log(`[backfill] Done: ${done} wallets scored`);
  console.log('[backfill] Badge distribution:', badgeCounts);
}

main().catch((err) => {
  console.error('[backfill] Failed:', err);
  process.exit(1);
});
