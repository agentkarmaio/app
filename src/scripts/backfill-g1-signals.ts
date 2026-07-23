/**
 * Backfill Tier 2 `x402_payment` signal_events for every historical transaction.
 *
 * Idempotent via uniq_signal_events_dedup — re-runs won't duplicate.
 *
 * Usage:
 *   bun run src/scripts/backfill-g1-signals.ts
 */

import { getAllTransactions, FULL_BACKFILL_TX_BOUND, insertSignalEvents } from '../db/client';
import { buildX402PaymentSignals } from '../scoring/signals';

async function main() {
  console.log('[backfill-g1] Loading all transactions…');
  const txs = await getAllTransactions(FULL_BACKFILL_TX_BOUND);
  console.log(`[backfill-g1] ${txs.length} transactions to emit signals for`);

  if (txs.length === 0) return;

  const signals = buildX402PaymentSignals(txs);
  console.log(`[backfill-g1] Upserting ${signals.length} signal_events (chunked)…`);
  const inserted = await insertSignalEvents(signals);
  console.log(`[backfill-g1] New rows: ${inserted} (rest deduped)`);
}

main().catch((err) => {
  console.error('[backfill-g1] Failed:', err);
  process.exit(1);
});
