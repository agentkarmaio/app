/**
 * Rescore worker — drains the deferred scoring queue.
 *
 * The webhook marks wallets dirty when new txs land (wallets.scoring_dirty_at
 * set to NOW()). This script claims a batch, recomputes cadence / autonomy /
 * blended karma over a bounded window of each wallet's recent tx history,
 * writes scores + snapshot, and clears the dirty flag.
 *
 * Scheduled by Servel:
 *   servel job add rescore-karma \
 *     --schedule "* * * * *" \
 *     --app agentkarma \
 *     --command "bun run scripts/rescore-dirty.ts" \
 *     --timeout 5m \
 *     --skip-running
 *
 * Env:
 *   RESCORE_BATCH_SIZE   (default 200)   — wallets per invocation
 *   RESCORE_TX_WINDOW    (default 5000)  — tx history rows per wallet
 *
 * Usage:
 *   bun run scripts/rescore-dirty.ts             # drain one batch
 *   bun run scripts/rescore-dirty.ts 500         # batch size override
 */

import {
  claimDirtyWallets,
  countDirtyWallets,
  getRecentTransactionsForWallet,
  insertScoreSnapshot,
  insertSignalEvents,
  getLatestSignalValues,
  upsertWallet,
  markWalletsDirty,
} from '@/db/client';
import { calculateScore } from '@/scoring';
import { buildCadenceSignal, buildAutonomySignal } from '@/scoring/signals';
import { computeCadence } from '@/scoring/cadence';
import { computeAutonomy } from '@/scoring/autonomy';
import { readAttestations } from '@/integrations/attestation';

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_TX_WINDOW = 5000;
const CONCURRENCY = 8;

export interface RescoreResult {
  claimed: number;
  scored: number;
  skipped: number;
  errors: { address: string; message: string }[];
  remaining: number;
  elapsedMs: number;
}

async function rescoreOne(
  address: string,
  txWindow: number,
  attestations: Map<string, number>,
): Promise<boolean> {
  const txs = await getRecentTransactionsForWallet(address, txWindow);
  if (txs.length === 0) {
    // Wallet has no txs yet — claimed but nothing to score. Leave defaults.
    return false;
  }

  const timestamps = txs.map((tx) => new Date(tx.timestamp));
  const cadence = computeCadence(timestamps);
  const autonomy = computeAutonomy(
    txs.map((tx) => ({ timestamp: tx.timestamp, counterparty: tx.facilitator })),
  );

  // Persist Tier-2 cadence + autonomy signal rows (overwrite keeps latest).
  const signalRows = [];
  if (cadence) signalRows.push(buildCadenceSignal(address, cadence));
  if (autonomy) signalRows.push(buildAutonomySignal(address, autonomy));
  if (signalRows.length > 0) await insertSignalEvents(signalRows, { overwrite: true });

  const [manifestScores] = await Promise.all([
    getLatestSignalValues([address], 'manifest'),
  ]);

  const walletScore = calculateScore(
    txs,
    attestations.get(address) ?? 0,
    undefined,
    undefined,
    cadence?.automationScore ?? null,
    manifestScores.get(address) ?? null,
  );

  await upsertWallet(address, walletScore.score, walletScore.trustTier, walletScore.txCount, {
    providerScore: walletScore.providerScore,
    consumerScore: walletScore.consumerScore,
    confidenceBadge: walletScore.confidenceBadge,
    autonomyScore: autonomy?.score ?? null,
    autonomyLabel: autonomy?.label ?? null,
    metricSuccessRate: walletScore.metrics.successRate,
    metricDiversity:   walletScore.metrics.diversity,
    metricVolume:      walletScore.metrics.volume,
    metricAge:         walletScore.metrics.age,
    metricCadence:     walletScore.metrics.cadence,
  });

  await insertScoreSnapshot(
    address,
    walletScore.score,
    walletScore.metrics.successRate,
    walletScore.metrics.diversity,
    walletScore.metrics.volume,
    walletScore.metrics.age,
  );

  return true;
}

export async function drainOnce(
  batchSize = DEFAULT_BATCH_SIZE,
  txWindow = DEFAULT_TX_WINDOW,
): Promise<RescoreResult> {
  const start = Date.now();
  const claimed = await claimDirtyWallets(batchSize);
  if (claimed.length === 0) {
    return { claimed: 0, scored: 0, skipped: 0, errors: [], remaining: 0, elapsedMs: Date.now() - start };
  }

  const attestations = await readAttestations(claimed);

  const errors: { address: string; message: string }[] = [];
  let scored = 0;
  let skipped = 0;

  // Bounded concurrency — don't saturate Postgres connections.
  for (let i = 0; i < claimed.length; i += CONCURRENCY) {
    const slice = claimed.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      slice.map((addr) => rescoreOne(addr, txWindow, attestations)),
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const addr = slice[j];
      if (r.status === 'fulfilled') {
        if (r.value) scored++;
        else skipped++;
      } else {
        errors.push({ address: addr, message: r.reason instanceof Error ? r.reason.message : String(r.reason) });
      }
    }
  }

  // Failed wallets keep their dirty flag set so the next run retries them.
  if (errors.length > 0) {
    await markWalletsDirty(errors.map((e) => e.address));
  }

  const remaining = await countDirtyWallets();
  return {
    claimed: claimed.length,
    scored,
    skipped,
    errors,
    remaining,
    elapsedMs: Date.now() - start,
  };
}

export const RESCORE_DEFAULT_BATCH_SIZE = DEFAULT_BATCH_SIZE;
export const RESCORE_DEFAULT_TX_WINDOW = DEFAULT_TX_WINDOW;
