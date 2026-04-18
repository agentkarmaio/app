/**
 * Seed demo consumer feedback for an agent wallet. Picks N real transactions
 * (by recency) and inserts `delivered`-rated feedback rows, bypassing the
 * signed `/api/feedback` endpoint. Operator-only — intended to light up 🟢
 * receipt-backed confidence on showcase agents whose counterparty never
 * actually filed feedback.
 *
 * Because the feedback rows are tied to real tx_signatures from our indexed
 * history, the scoring engine picks them up automatically on next refresh.
 *
 * Usage:
 *   bun run src/scripts/seed-demo-feedback.ts <agentWallet> [--count 3] [--rating delivered|failed]
 */

import { PublicKey } from '@solana/web3.js';
import {
  supabase, getTransactions, insertFeedback, hasFeedbackForTx,
} from '../db/client';
import type { FeedbackRating } from '../db/schema';

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const named: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      named[a.slice(2)] = argv[++i] ?? '';
    } else {
      positional.push(a);
    }
  }
  return { positional, named };
}

async function main() {
  const { positional, named } = parseArgs(process.argv.slice(2));
  const agentWallet = positional[0];
  if (!agentWallet) {
    console.error('Usage: bun run src/scripts/seed-demo-feedback.ts <agentWallet> [--count N] [--rating delivered|failed]');
    process.exit(1);
  }
  try { new PublicKey(agentWallet); } catch {
    console.error('Invalid Solana wallet address.');
    process.exit(1);
  }

  const count   = Math.max(1, Math.min(20, Number(named.count) || 3));
  const rating  = (named.rating === 'failed' ? 'failed' : 'delivered') as FeedbackRating;

  // For demo: generate synthetic consumer wallets. In real use these would
  // be the tx senders (they ARE the consumers), but since wallet_address in
  // our schema already stores the sender, feedback has to come from a
  // *different* wallet (the recipient / counterparty). We fake that with a
  // deterministic alias derived from the tx signature.
  const txs = await getTransactions(agentWallet, count);
  if (txs.length === 0) {
    console.error(`No transactions found for ${agentWallet}. Pick a wallet with ≥1 tx.`);
    process.exit(1);
  }

  // Look up wallet row to confirm it exists + print context.
  const { data: walletRows } = await supabase
    .from('wallets')
    .select('address, display_name, tx_count, confidence_badge')
    .eq('address', agentWallet)
    .limit(1);
  const walletRow = (walletRows ?? [])[0];
  console.log(
    `[seed-feedback] Target: ${walletRow?.display_name ?? agentWallet.slice(0, 8)}… (tx_count=${walletRow?.tx_count ?? '?'}, badge=${walletRow?.confidence_badge ?? '?'})`,
  );

  let written = 0, skipped = 0;
  for (const tx of txs) {
    if (await hasFeedbackForTx(tx.tx_signature)) {
      skipped++;
      continue;
    }
    // Derive a stable fake consumer wallet that's visibly synthetic: use a
    // deterministic name, not a real pubkey, so it's never confused with one.
    const consumerWallet = `demo-counterparty-${tx.tx_signature.slice(0, 8)}`;
    await insertFeedback(agentWallet, consumerWallet, rating, tx.tx_signature);
    written++;
    console.log(
      `[seed-feedback] ✓ ${rating} · tx ${tx.tx_signature.slice(0, 8)}… (${new Date(tx.timestamp).toISOString().slice(0, 10)})`,
    );
  }

  console.log(`[seed-feedback] Done. Written: ${written}. Skipped existing: ${skipped}.`);
  console.log('[seed-feedback] Trigger a refresh so the Tier 1 signal blends into the score:');
  console.log(`       curl -X POST https://agentkarma.io/api/score/refresh -d '{"wallet":"${agentWallet}"}'`);
}

main().catch((err) => {
  console.error('[seed-feedback] Failed:', err);
  process.exit(1);
});
