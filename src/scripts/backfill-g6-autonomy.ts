/**
 * Backfill Autonomy Confidence signals + wallets.autonomy_score for every
 * wallet with enough transactions to classify (RFC v0.3 §5.5).
 *
 * Usage:
 *   bun run src/scripts/backfill-g6-autonomy.ts
 */

import { getAllTransactions, insertSignalEvents, supabase } from '../db/client';
import { computeAutonomy, MIN_TX_FOR_AUTONOMY } from '../scoring/autonomy';
import { buildAutonomySignal } from '../scoring/signals';

async function main() {
  console.log('[backfill-g6] Loading all transactions…');
  const txs = await getAllTransactions();
  console.log(`[backfill-g6] ${txs.length} tx`);

  const byWallet = new Map<string, Array<{ timestamp: string | Date; counterparty: string | null }>>();
  for (const tx of txs) {
    const list = byWallet.get(tx.wallet_address) ?? [];
    list.push({ timestamp: tx.timestamp, counterparty: tx.facilitator });
    byWallet.set(tx.wallet_address, list);
  }
  console.log(`[backfill-g6] ${byWallet.size} distinct wallets`);

  const signals = [];
  const walletUpdates: Array<{ address: string; score: number; label: string }> = [];
  const buckets = [0, 0, 0]; // human-like / mixed / agent-like
  let skipped = 0;

  for (const [wallet, entries] of byWallet) {
    const autonomy = computeAutonomy(entries);
    if (!autonomy) {
      skipped++;
      continue;
    }
    signals.push(buildAutonomySignal(wallet, autonomy));
    walletUpdates.push({ address: wallet, score: autonomy.score, label: autonomy.label });
    if (autonomy.label === 'human-like') buckets[0]++;
    else if (autonomy.label === 'mixed') buckets[1]++;
    else buckets[2]++;
  }

  console.log(
    `[backfill-g6] Emitting ${signals.length} autonomy signals (skipped ${skipped} with <${MIN_TX_FOR_AUTONOMY} tx)`,
  );
  const written = await insertSignalEvents(signals, { overwrite: true });
  console.log(`[backfill-g6] Wrote ${written} signal rows`);

  console.log(`[backfill-g6] Updating wallets.autonomy_score for ${walletUpdates.length} rows…`);
  for (let i = 0; i < walletUpdates.length; i += 100) {
    const chunk = walletUpdates.slice(i, i + 100);
    await Promise.all(
      chunk.map(({ address, score, label }) =>
        supabase
          .from('wallets')
          .update({ autonomy_score: score, autonomy_label: label })
          .eq('address', address),
      ),
    );
  }

  console.log('[backfill-g6] label distribution:', {
    'human-like': buckets[0],
    'mixed': buckets[1],
    'agent-like': buckets[2],
  });
}

main().catch((err) => {
  console.error('[backfill-g6] Failed:', err);
  process.exit(1);
});
