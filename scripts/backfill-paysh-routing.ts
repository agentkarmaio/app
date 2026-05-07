/**
 * Backfill `paysh_routed` Tier 1 signal_events for every historical x402
 * transaction (sprint A1).
 *
 * Iterates `transactions` rows in batches, re-fetches each via Helius
 * parseTransactionsBatch, runs `detectPayshRouted`, and emits a Tier 1
 * `paysh_routed` signal for matches. Idempotent — the unique index on
 * (agent_wallet, kind, tx_ref) handles dedup, so re-runs are safe.
 *
 * Flags:
 *   --dry-run   Print classifications without writing to DB.
 *   --limit=N   Cap total transactions scanned (useful for smoke tests).
 *
 * Usage:
 *   bun run web/scripts/backfill-paysh-routing.ts --dry-run
 *   bun run web/scripts/backfill-paysh-routing.ts --dry-run --limit=500
 *   bun run web/scripts/backfill-paysh-routing.ts            # write mode
 */

import { getAllTransactions, insertSignalEvents, type InsertSignalEventInput } from '../src/db/client';
import { parseTransactionsBatch, extractPayshPayment } from '../src/indexer/helius';
import { buildPayshRoutedSignal } from '../src/scoring/signals';
import { PAYSH_OPERATORS } from '../src/config/paysh-operators';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitFlag = args.find((a) => a.startsWith('--limit='));
const limitArg = limitFlag ? Number.parseInt(limitFlag.split('=')[1] ?? '', 10) : NaN;
const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : null;

const HELIUS_BATCH_SIZE = 100;
const PROGRESS_EVERY = 500;

interface Hit {
  wallet: string;
  txSignature: string;
  operatorAddress: string;
  operatorId: string;
  protocol: 'x402' | 'mpp' | 'hybrid';
  observedAt: string;
}

async function main(): Promise<void> {
  console.log(`[paysh-backfill] Mode: ${dryRun ? 'DRY-RUN (no DB writes)' : 'WRITE'}`);
  console.log(`[paysh-backfill] Operator registry: ${Object.keys(PAYSH_OPERATORS).length} operators`);
  for (const [id, op] of Object.entries(PAYSH_OPERATORS)) {
    console.log(`  - ${id} (${op.protocol}): ${op.recipient.slice(0, 8)}… / ${op.feePayer.slice(0, 8)}…`);
  }

  console.log('[paysh-backfill] Loading all transactions from DB…');
  const txs = await getAllTransactions();
  console.log(`[paysh-backfill] ${txs.length} historical transactions`);

  const work = limit ? txs.slice(0, limit) : txs;
  if (limit) console.log(`[paysh-backfill] Capped to first ${work.length} transactions`);

  const hits: Hit[] = [];
  let scanned = 0;
  let parsed = 0;
  const startedAt = Date.now();

  for (let i = 0; i < work.length; i += HELIUS_BATCH_SIZE) {
    const chunk = work.slice(i, i + HELIUS_BATCH_SIZE);
    const sigs = chunk.map((t) => t.tx_signature);

    let parsedTxs;
    try {
      parsedTxs = await parseTransactionsBatch(sigs);
    } catch (err) {
      console.warn(`[paysh-backfill] Helius batch failed (${chunk.length} sigs):`, err);
      scanned += chunk.length;
      continue;
    }

    parsed += parsedTxs.length;
    for (const tx of parsedTxs) {
      const paysh = extractPayshPayment(tx);
      if (!paysh) continue;
      hits.push({
        wallet: paysh.wallet,
        txSignature: paysh.txSignature,
        operatorAddress: paysh.operatorAddress,
        operatorId: paysh.operatorId,
        protocol: paysh.protocol,
        observedAt: paysh.observedAt,
      });
    }

    scanned += chunk.length;
    if (scanned % PROGRESS_EVERY < HELIUS_BATCH_SIZE) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `[paysh-backfill] ${scanned}/${work.length} scanned, ${parsed} parsed, ${hits.length} hits (${elapsed}s)`,
      );
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[paysh-backfill] Done. Scanned ${scanned}, parsed ${parsed}, classified ${hits.length} as pay.sh-routed in ${elapsed}s`,
  );

  if (hits.length === 0) {
    console.log('[paysh-backfill] No pay.sh-routed transactions in scanned set.');
    return;
  }

  // Group by operator for the summary.
  const byOperator = new Map<string, number>();
  for (const h of hits) {
    byOperator.set(h.operatorId, (byOperator.get(h.operatorId) ?? 0) + 1);
  }
  console.log('[paysh-backfill] Hits by operator:');
  for (const [id, count] of byOperator) console.log(`  ${id}: ${count}`);

  console.log('[paysh-backfill] Sample hits (up to 5):');
  for (const h of hits.slice(0, 5)) {
    console.log(
      `  ${h.txSignature} — wallet ${h.wallet.slice(0, 8)}… → ${h.operatorId} (${h.protocol})`,
    );
  }

  if (dryRun) {
    console.log('[paysh-backfill] Dry-run: skipping signal_events insert.');
    return;
  }

  const signals: InsertSignalEventInput[] = hits.map((h) =>
    buildPayshRoutedSignal({
      walletAddress: h.wallet,
      txSignature: h.txSignature,
      operatorAddress: h.operatorAddress,
      operatorId: h.operatorId,
      protocol: h.protocol,
      observedAt: h.observedAt,
    }),
  );
  console.log(`[paysh-backfill] Upserting ${signals.length} paysh_routed signal_events…`);
  const inserted = await insertSignalEvents(signals);
  console.log(`[paysh-backfill] New rows: ${inserted} (rest deduped via uniq_signal_events_dedup)`);
}

main().catch((err) => {
  console.error('[paysh-backfill] Fatal:', err);
  process.exit(1);
});
