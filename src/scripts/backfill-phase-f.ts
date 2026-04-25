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

  // Skip 8004 attestation fetch by default — empirically every wallet returns
  // 0 (no on-chain attestations exist for this fleet yet) and the per-wallet
  // RPC roundtrips with rate-limit retries can blow past 2h on 30k+ wallets.
  // Set BACKFILL_FETCH_ATTESTATIONS=1 to re-enable when receipts start landing.
  let attestations: Awaited<ReturnType<typeof readAttestations>>;
  if (process.env.BACKFILL_FETCH_ATTESTATIONS === '1') {
    console.log('[backfill] Fetching 8004 attestations…');
    attestations = await readAttestations(wallets);
    console.log(`[backfill] ${attestations.size} wallets have 8004 attestations`);
  } else {
    console.log('[backfill] Skipping 8004 attestations (set BACKFILL_FETCH_ATTESTATIONS=1 to enable)');
    attestations = new Map<string, number>();
  }

  console.log('[backfill] Loading manifest signals…');
  const manifestScores = await getLatestSignalValues(wallets, 'manifest');
  console.log(`[backfill] ${manifestScores.size} wallets have a manifest`);

  const txByWallet = new Map<string, typeof allTx>();
  for (const tx of allTx) {
    const list = txByWallet.get(tx.wallet_address) ?? [];
    list.push(tx);
    txByWallet.set(tx.wallet_address, list);
  }

  // Process wallets concurrently — each wallet does 3 sequential DB roundtrips
  // (feedback summary + upsert + snapshot), so serial throughput tops out at
  // ~1 wallet/sec. With CONCURRENCY=8 we cover 34k wallets in ~10-15 min.
  const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY) || 8;
  let done = 0;
  let failed = 0;
  const badgeCounts: Record<string, number> = {};
  const queue = [...wallets];
  const total = wallets.length;

  async function processOne(wallet: string) {
    const txs = txByWallet.get(wallet) ?? [];
    if (txs.length === 0) return;

    try {
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
      badgeCounts[score.confidenceBadge] = (badgeCounts[score.confidenceBadge] ?? 0) + 1;
      done++;
      if (done % 100 === 0) console.log(`[backfill] ${done}/${total} (${failed} skipped)`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      if (failed <= 5 || failed % 50 === 0) {
        console.warn(`[backfill] skip ${wallet.slice(0, 6)}… (${failed} total): ${msg.slice(0, 120)}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length > 0) {
        const w = queue.shift();
        if (!w) return;
        await processOne(w);
      }
    }),
  );

  console.log(`[backfill] Done: ${done} wallets scored, ${failed} skipped`);
  console.log('[backfill] Badge distribution:', badgeCounts);
}

main().catch((err) => {
  console.error('[backfill] Failed:', err);
  process.exit(1);
});
