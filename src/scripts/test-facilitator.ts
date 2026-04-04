/**
 * test-facilitator.ts
 *
 * Fetches the last 10 USDC transfers to/from the DEXTER facilitator address.
 * Uses @solana/web3.js with public Solana mainnet RPC.
 *
 * Run: bun src/scripts/test-facilitator.ts
 */

import {
  Connection,
  PublicKey,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { getFacilitatorName } from "@/config/facilitators";

// ─── Config ──────────────────────────────────────────────────────────────────

const DEXTER_ADDRESS = "DEXVS3su4dZQWTvvPnLDJLRK1CeeKG6K3QqdzthgAkNV";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RPC_ENDPOINT =
  process.env.SOLANA_RPC_URL ||
  "https://api.mainnet-beta.solana.com";
const LIMIT = 10;

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface UsdcTransfer {
  signature: string;
  slot: number;
  blockTime: number | null;
  from: string | null;
  to: string | null;
  amount: number | null; // USDC (human-readable)
  success: boolean;
}

function extractUsdcTransfer(
  tx: ParsedTransactionWithMeta,
  sig: string
): UsdcTransfer | null {
  const meta = tx.meta;
  if (!meta) return null;

  // Look through token balance deltas for USDC
  const preBalances = meta.preTokenBalances ?? [];
  const postBalances = meta.postTokenBalances ?? [];

  let from: string | null = null;
  let to: string | null = null;
  let amount: number | null = null;

  // Find the account whose USDC balance decreased (sender) and increased (receiver)
  for (const post of postBalances) {
    if (post.mint !== USDC_MINT) continue;

    const pre = preBalances.find(
      (p) => p.accountIndex === post.accountIndex && p.mint === USDC_MINT
    );
    const preLamports = pre ? Number(pre.uiTokenAmount.uiAmount ?? 0) : 0;
    const postLamports = Number(post.uiTokenAmount.uiAmount ?? 0);
    const delta = postLamports - preLamports;

    if (delta > 0) {
      // Positive delta → receiver
      to = post.owner ?? null;
      amount = delta;
    } else if (delta < 0) {
      // Negative delta → sender
      from = post.owner ?? null;
    }
  }

  return {
    signature: sig,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    from,
    to,
    amount,
    success: meta.err === null,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const facilitatorName = getFacilitatorName(DEXTER_ADDRESS);
  console.log("=".repeat(60));
  console.log(`Karma — Facilitator Test`);
  console.log(`Facilitator : ${facilitatorName?.toUpperCase() ?? "UNKNOWN"}`);
  console.log(`Address     : ${DEXTER_ADDRESS}`);
  console.log(`Fetching    : last ${LIMIT} signatures…`);
  console.log(`RPC         : ${RPC_ENDPOINT}`);
  console.log("=".repeat(60));

  const connection = new Connection(RPC_ENDPOINT, "confirmed");
  const pubkey = new PublicKey(DEXTER_ADDRESS);

  // Step 1: Get last N signatures for this address
  const signatures = await connection.getSignaturesForAddress(pubkey, {
    limit: LIMIT,
  });

  console.log(`\nFound ${signatures.length} signatures\n`);

  // Step 2: Fetch each transaction
  const results: UsdcTransfer[] = [];

  for (const sigInfo of signatures) {
    try {
      const tx = await connection.getParsedTransaction(sigInfo.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });

      if (!tx) {
        console.warn(`  [skip] ${sigInfo.signature.slice(0, 16)}… — no tx data`);
        continue;
      }

      const transfer = extractUsdcTransfer(tx, sigInfo.signature);
      if (transfer) {
        results.push(transfer);
      } else {
        // Non-USDC or non-transfer tx — still log it
        results.push({
          signature: sigInfo.signature,
          slot: tx.slot,
          blockTime: tx.blockTime ?? null,
          from: null,
          to: null,
          amount: null,
          success: tx.meta ? tx.meta.err === null : false,
        });
      }
    } catch (err) {
      console.error(`  [error] ${sigInfo.signature.slice(0, 16)}…`, err);
    }
  }

  // Step 3: Print results
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Results (${results.length} transactions)\n`);

  for (const r of results) {
    const date = r.blockTime
      ? new Date(r.blockTime * 1000).toISOString()
      : "unknown time";
    const status = r.success ? "✅" : "❌";
    const amountStr =
      r.amount !== null ? `${r.amount.toFixed(6)} USDC` : "(non-USDC)";

    console.log(`${status} ${r.signature.slice(0, 24)}…`);
    console.log(`   Time   : ${date}`);
    console.log(`   Slot   : ${r.slot}`);
    console.log(`   Amount : ${amountStr}`);
    if (r.from) console.log(`   From   : ${r.from}`);
    if (r.to)   console.log(`   To     : ${r.to}`);
    console.log();
  }

  // Stats summary
  const usdcTxs = results.filter((r) => r.amount !== null);
  const totalVolume = usdcTxs.reduce((sum, r) => sum + (r.amount ?? 0), 0);
  const successRate =
    results.length > 0
      ? (results.filter((r) => r.success).length / results.length) * 100
      : 0;

  console.log("─".repeat(60));
  console.log("Summary");
  console.log(`  Total txs   : ${results.length}`);
  console.log(`  USDC txs    : ${usdcTxs.length}`);
  console.log(`  Total vol   : ${totalVolume.toFixed(6)} USDC`);
  console.log(`  Success rate: ${successRate.toFixed(1)}%`);
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
