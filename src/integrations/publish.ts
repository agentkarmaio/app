/**
 * Shared publish logic: karma scores → on-chain attestations, chain-dispatched.
 * Used by the CLI (`bun run publish`) and the cron route. Per-wallet writes go
 * through getAdapter(chain).publishAttestation; idempotency delta-skip stays here.
 *
 * Idempotency: before writing, reads the current on-chain score via the adapter
 * (readAttestation). Skips the write if |newScore - onChainScore| < DELTA_THRESHOLD.
 * This avoids bloating the registry with near-identical feedback entries on each
 * cron fire.
 */

import type { Chain } from '@/db/schema';
import { DEFAULT_CHAIN } from '@/db/schema';
import { getLeaderboard as dbGetLeaderboard, getTransactions as dbGetTransactions } from '../db/client';
import { calculateScore as scoringCalculateScore } from '../scoring/index';
import { getAdapter as registryGetAdapter } from '@/chain-adapters/registry';

export interface PublishRunResult {
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

// Test seam — injects pure deps so the dispatch + aggregation logic is unit-
// testable without DB or chain. Production uses the real imports.
interface PublishDeps {
  getLeaderboard: typeof dbGetLeaderboard;
  getTransactions: typeof dbGetTransactions;
  calculateScore: typeof scoringCalculateScore;
  getAdapter: typeof registryGetAdapter;
}
let _deps: PublishDeps | null = null;
export function __setPublishDepsForTest(deps: unknown): void { _deps = deps as PublishDeps; }
function deps(): PublishDeps {
  return _deps ?? {
    getLeaderboard: dbGetLeaderboard,
    getTransactions: dbGetTransactions,
    calculateScore: scoringCalculateScore,
    getAdapter: registryGetAdapter,
  };
}

export async function publishTopScores(
  limit = 50,
  chain: Chain = DEFAULT_CHAIN,
): Promise<PublishRunResult> {
  const { getLeaderboard, getTransactions, calculateScore, getAdapter } = deps();
  const adapter = getAdapter(chain);

  const { wallets } = await getLeaderboard(limit);
  const result: PublishRunResult = { published: 0, skipped: 0, errors: 0, dryRun: false, details: [] };

  for (const wallet of wallets) {
    try {
      const transactions = await getTransactions(wallet.address, 1000);
      if (transactions.length === 0) {
        result.skipped++;
        result.details.push({ address: wallet.address, status: 'skipped', score: 0, reason: 'no transactions' });
        continue;
      }

      const score = calculateScore(transactions);

      // Idempotency: skip if on-chain score hasn't drifted past the threshold.
      let onChainScore: number | null = null;
      try { onChainScore = await adapter.readAttestation(wallet.address); } catch { onChainScore = null; }
      if (onChainScore != null && onChainScore > 0) {
        const delta = Math.abs(score.score - onChainScore);
        if (delta < DELTA_THRESHOLD) {
          result.skipped++;
          result.details.push({
            address: wallet.address, status: 'skipped', score: score.score, onChainScore,
            reason: `delta ${delta.toFixed(1)} < threshold ${DELTA_THRESHOLD}`,
          });
          continue;
        }
      }

      const pub = await adapter.publishAttestation(wallet.address, score);
      if (pub.skipped) {
        result.skipped++;
        result.details.push({ address: wallet.address, status: 'skipped', score: score.score, onChainScore, reason: pub.reason });
      } else {
        if (pub.dryRun) result.dryRun = true;
        result.published++;
        result.details.push({
          address: wallet.address, status: pub.dryRun ? 'dry-run' : 'published',
          score: score.score, onChainScore, signature: pub.txId,
        });
      }

      await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
    } catch (err) {
      result.errors++;
      result.details.push({ address: wallet.address, status: 'error', score: 0, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}
