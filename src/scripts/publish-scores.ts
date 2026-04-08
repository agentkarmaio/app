/**
 * Publish Karma Scores to 8004 On-Chain
 *
 * Reads top-scored wallets from DB and writes their karma scores
 * as 8004 feedback attestations on Solana.
 *
 * Usage:
 *   bun run publish           # Publish top 20 (dry-run without SOLANA_PRIVATE_KEY)
 *   bun run publish 50        # Publish top 50
 *
 * Env:
 *   SOLANA_PRIVATE_KEY   — JSON array of keypair bytes (required for real writes)
 *   HELIUS_RPC_URL       — RPC endpoint (optional, defaults to public)
 */

import { getLeaderboard, getTransactions } from '../db/client';
import { calculateScore } from '../scoring/index';
import { initSDKFromEnv, writeFeedback } from '../integrations/erc8004';

const limit = Number(process.argv[2]) || 20;

async function main() {
  console.log(`[publish] Publishing top ${limit} wallet scores to 8004...`);

  const sdk = initSDKFromEnv();
  if (!sdk) {
    console.log('[publish] Running in DRY-RUN mode (no SOLANA_PRIVATE_KEY)');
  }

  const wallets = await getLeaderboard(limit);
  console.log(`[publish] Found ${wallets.length} wallets to publish`);

  let published = 0;
  let errors = 0;

  for (const wallet of wallets) {
    try {
      const transactions = await getTransactions(wallet.address, 1000);
      if (transactions.length === 0) continue;

      const score = calculateScore(transactions);

      const result = await writeFeedback(sdk, wallet.address, score);

      if (result.dryRun) {
        console.log(`  [dry-run] ${wallet.address.slice(0, 8)}... → ${score.score} (${score.trustTier})`);
      } else {
        console.log(`  [wrote] ${wallet.address.slice(0, 8)}... → ${score.score} (${score.trustTier}) tx: ${result.signature ?? 'pending'}`);
      }

      published++;

      // Rate limit: 200ms between writes
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.error(`  [error] ${wallet.address.slice(0, 8)}...:`, err instanceof Error ? err.message : err);
      errors++;
    }
  }

  console.log(`\n[publish] Done. Published: ${published}, Errors: ${errors}`);
  if (!sdk) {
    console.log('[publish] Set SOLANA_PRIVATE_KEY to write real on-chain attestations.');
  }
}

main().catch(console.error);
