/**
 * Publish Karma Scores to 8004 On-Chain (CLI bootstrap)
 *
 * Thin wrapper around publishTopScores(). Idempotent via on-chain delta check.
 *
 * Usage:
 *   bun run publish           # Publish top 20 (dry-run without SOLANA_PRIVATE_KEY)
 *   bun run publish 100       # Publish top 100
 *
 * Env:
 *   SOLANA_PRIVATE_KEY   — JSON array of keypair bytes (required for real writes)
 *   HELIUS_RPC_URL       — RPC endpoint (optional, defaults to public)
 */

import { publishTopScores } from '../integrations/publish';

const limit = Number(process.argv[2]) || 20;

async function main() {
  console.log(`[publish] Publishing top ${limit} wallet scores to 8004...`);

  const result = await publishTopScores(limit);

  if (result.dryRun) {
    console.log('[publish] Running in DRY-RUN mode (no SOLANA_PRIVATE_KEY)');
  }

  for (const d of result.details) {
    const addr = d.address.slice(0, 8) + '…';
    if (d.status === 'published') {
      console.log(`  [wrote] ${addr} → ${d.score} (tx: ${d.signature ?? 'pending'})`);
    } else if (d.status === 'dry-run') {
      console.log(`  [dry-run] ${addr} → ${d.score}`);
    } else if (d.status === 'skipped') {
      console.log(`  [skip] ${addr} → ${d.reason}`);
    } else {
      console.log(`  [err]  ${addr} → ${d.reason}`);
    }
  }

  console.log(
    `\n[publish] Done. published=${result.published} skipped=${result.skipped} errors=${result.errors}`,
  );
  if (result.dryRun) {
    console.log('[publish] Set SOLANA_PRIVATE_KEY to write real on-chain attestations.');
  }
}

main().catch((err) => {
  console.error('[publish] Fatal:', err);
  process.exit(1);
});
