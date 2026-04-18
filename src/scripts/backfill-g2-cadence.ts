/**
 * Backfill Tier 2 `cadence` signal_events for every wallet with enough
 * transactions to classify. Idempotent via `AGGREGATE_TX_REF` — re-running
 * overwrites in place.
 *
 * Usage:
 *   bun run src/scripts/backfill-g2-cadence.ts
 */

import { getAllTransactions, insertSignalEvents } from '../db/client';
import { computeCadence, MIN_TX_FOR_CADENCE } from '../scoring/cadence';
import { buildCadenceSignal } from '../scoring/signals';

async function main() {
  console.log('[backfill-g2] Loading all transactions…');
  const txs = await getAllTransactions();
  console.log(`[backfill-g2] ${txs.length} tx`);

  const byWallet = new Map<string, Date[]>();
  for (const tx of txs) {
    const list = byWallet.get(tx.wallet_address) ?? [];
    list.push(new Date(tx.timestamp));
    byWallet.set(tx.wallet_address, list);
  }
  console.log(`[backfill-g2] ${byWallet.size} distinct wallets`);

  const signals = [];
  let skipped = 0;
  for (const [wallet, timestamps] of byWallet) {
    const cadence = computeCadence(timestamps);
    if (!cadence) {
      skipped++;
      continue;
    }
    signals.push(buildCadenceSignal(wallet, cadence));
  }
  console.log(
    `[backfill-g2] Emitting ${signals.length} cadence signals (skipped ${skipped} with <${MIN_TX_FOR_CADENCE} tx)`,
  );

  const written = await insertSignalEvents(signals, { overwrite: true });
  console.log(`[backfill-g2] Wrote ${written} rows (overwrite mode)`);

  // Quick sanity histogram of automation scores
  const buckets = [0, 0, 0, 0, 0]; // [0, 0.2, 0.4, 0.6, 0.8, 1.0]
  for (const s of signals) {
    const v = Number(s.value ?? 0);
    const idx = Math.min(4, Math.floor(v * 5));
    buckets[idx]++;
  }
  console.log('[backfill-g2] automationScore distribution (0→1):', buckets);
}

main().catch((err) => {
  console.error('[backfill-g2] Failed:', err);
  process.exit(1);
});
