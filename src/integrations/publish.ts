/**
 * Shared publish logic for karma scores → 8004 attestations.
 *
 * Used by both:
 *   - CLI bootstrap: `bun run publish <limit>`
 *   - Cron endpoint: POST /api/cron/publish
 *
 * Idempotency: before writing, reads the current on-chain average score via
 * sdk.getSummary(). Skips the write if |newScore - onChainScore| < DELTA_THRESHOLD.
 * This avoids bloating the registry with near-identical feedback entries on each
 * cron fire.
 */

import { PublicKey } from '@solana/web3.js';
import { getLeaderboard, getTransactions } from '../db/client';
import { calculateScore } from '../scoring/index';
import { initSDKFromEnv, writeFeedback, readScore } from './erc8004';

export interface PublishResult {
  published: number;
  skipped: number;
  errors: number;
  dryRun: boolean;
  details: Array<{
    address: string;
    status: 'published' | 'skipped' | 'error' | 'dry-run';
    score: number;
    onChainScore?: number | null;
    signature?: string;
    reason?: string;
  }>;
}

const DELTA_THRESHOLD = 3; // points — min change to justify a new on-chain write
const RATE_LIMIT_MS = 200;

export async function publishTopScores(limit = 50): Promise<PublishResult> {
  const sdk = initSDKFromEnv();
  const dryRun = sdk === null;

  const { wallets } = await getLeaderboard(limit);

  const result: PublishResult = {
    published: 0,
    skipped: 0,
    errors: 0,
    dryRun,
    details: [],
  };

  for (const wallet of wallets) {
    try {
      const transactions = await getTransactions(wallet.address, 1000);
      if (transactions.length === 0) {
        result.skipped++;
        result.details.push({
          address: wallet.address,
          status: 'skipped',
          score: 0,
          reason: 'no transactions',
        });
        continue;
      }

      const score = calculateScore(transactions);

      // Idempotency check — skip if on-chain score hasn't drifted enough
      let onChainScore: number | null = null;
      if (sdk) {
        try {
          onChainScore = await readScore(sdk, new PublicKey(wallet.address));
        } catch {
          onChainScore = null; // treat read failure as "not published yet"
        }

        if (onChainScore != null) {
          const delta = Math.abs(score.score - onChainScore);
          if (delta < DELTA_THRESHOLD) {
            result.skipped++;
            result.details.push({
              address: wallet.address,
              status: 'skipped',
              score: score.score,
              onChainScore,
              reason: `delta ${delta.toFixed(1)} < threshold ${DELTA_THRESHOLD}`,
            });
            continue;
          }
        }
      }

      const writeResult = await writeFeedback(sdk, wallet.address, score);

      result.published++;
      result.details.push({
        address: wallet.address,
        status: writeResult.dryRun ? 'dry-run' : 'published',
        score: score.score,
        onChainScore,
        signature: writeResult.signature,
      });

      await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
    } catch (err) {
      result.errors++;
      result.details.push({
        address: wallet.address,
        status: 'error',
        score: 0,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
