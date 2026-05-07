/**
 * Karma Indexer — Fetches x402 USDC payment transactions from Solana
 * for all known facilitator addresses.
 *
 * Uses Helius Enhanced Transactions API for batch parsing (fast),
 * with cursor-based incremental indexing and parallel facilitator fetching.
 *
 * Env:
 *   HELIUS_RPC_URL — Helius endpoint with api-key (required for batch parsing)
 *   SOLANA_RPC_URL — Fallback Solana RPC endpoint
 */

import {
  Connection,
  PublicKey,
} from '@solana/web3.js';
import type { ConfirmedSignatureInfo } from '@solana/web3.js';
import {
  ALL_FACILITATOR_ADDRESSES,
  getFacilitatorName,
} from '../config/facilitators';
import {
  PAYSH_OPERATOR_ADDRESSES,
  getPayshOperatorByAddress,
} from '../config/paysh-operators';
import {
  SPECIMEN_ADDRESSES,
  SPECIMEN_FACILITATOR_LABEL,
  SPECIMEN_PROVIDER_ADDRESS,
} from '../config/specimen';
import type { Transaction } from '../db/schema';
import {
  insertTransactions,
  upsertWallet,
  insertScoreSnapshot,
  getTransactionsForWallets,
  getCursor,
  upsertCursor,
  insertSignalEvents,
  getLatestSignalValues,
  countSignalEventsByKind,
  type InsertSignalEventInput,
} from '../db/client';
import { calculateScores } from '../scoring';
import {
  buildX402PaymentSignals,
  buildCadenceSignal,
  buildAutonomySignal,
  buildPayshRoutedSignal,
} from '../scoring/signals';
import { computeCadence } from '../scoring/cadence';
import { computeAutonomy, type AutonomyResult } from '../scoring/autonomy';
import { readAttestations } from '../integrations/attestation';
import {
  parseTransactionsBatch,
  extractX402Payment,
  extractPayshPayment,
  withConcurrency,
  type HeliusEnhancedTransaction,
  type PayshExtractedPayment,
} from './helius';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
const DEFAULT_LIMIT = 100;
const FACILITATOR_CONCURRENCY = 5;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getConnection(): Connection {
  const rpcUrl = process.env.HELIUS_RPC_URL ?? process.env.SOLANA_RPC_URL ?? DEFAULT_RPC;
  return new Connection(rpcUrl, 'confirmed');
}

// ─── Fetch Pipeline ─────────────────────────────────────────────────────────

/**
 * Fetch and parse x402 transactions for a single facilitator address.
 *
 * 1. getSignaturesForAddress — one RPC call to get signature list
 * 2. parseTransactionsBatch — one Helius API call per 100 sigs (batch parsing)
 * 3. extractX402Payment — filter for USDC payments
 * 4. extractPayshPayment — opportunistically tag pay.sh-routed txs (sprint A1)
 */
export async function fetchTransactionsForFacilitator(
  address: string,
  limit: number = DEFAULT_LIMIT,
  options?: { until?: string; before?: string },
): Promise<{
  transactions: Omit<Transaction, 'id'>[];
  paysh: PayshExtractedPayment[];
  latestSignature: string | null;
}> {
  const connection = getConnection();
  const pubkey = new PublicKey(address);

  const sigOpts: { limit: number; until?: string; before?: string } = { limit };
  if (options?.until) sigOpts.until = options.until;
  if (options?.before) sigOpts.before = options.before;

  let signatures: ConfirmedSignatureInfo[];
  try {
    signatures = await connection.getSignaturesForAddress(pubkey, sigOpts);
  } catch (err) {
    console.error(`[indexer] Failed to get signatures for ${address}:`, err);
    return { transactions: [], paysh: [], latestSignature: null };
  }

  if (signatures.length === 0) {
    const name = getFacilitatorName(address) ?? 'unknown';
    console.log(`[indexer] ${address} (${name}): 0 new signatures`);
    return { transactions: [], paysh: [], latestSignature: null };
  }

  const latestSignature = signatures[0].signature;
  const sigStrings = signatures.map((s) => s.signature);

  // Batch parse via Helius Enhanced Transactions API
  const parsed = await parseTransactionsBatch(sigStrings);

  const results: Omit<Transaction, 'id'>[] = [];
  const payshHits: PayshExtractedPayment[] = [];
  for (const tx of parsed) {
    const payment = extractX402Payment(tx, address);
    if (payment) results.push(payment);

    // Pay.sh fingerprint runs orthogonally — a single tx can be both x402-
    // recorded (as a payer transfer) and pay.sh-routed (operator gateway).
    const paysh = extractPayshPayment(tx);
    if (paysh) payshHits.push(paysh);
  }

  const facName = getFacilitatorName(address);
  const paysh = getPayshOperatorByAddress(address);
  const isSpecimen = address === SPECIMEN_PROVIDER_ADDRESS;
  const name = facName
    ?? (paysh ? `pay.sh:${paysh.id}` : null)
    ?? (isSpecimen ? SPECIMEN_FACILITATOR_LABEL : 'unknown');
  console.log(
    `[indexer] ${address} (${name}): ${results.length}/${signatures.length} USDC txs` +
    (payshHits.length > 0 ? ` (+${payshHits.length} pay.sh-routed)` : ''),
  );
  return { transactions: results, paysh: payshHits, latestSignature };
}

/**
 * Fetch x402 transactions for ALL known facilitator addresses.
 * Uses stored cursors for incremental indexing unless backfill mode is set.
 * Processes facilitators in parallel (FACILITATOR_CONCURRENCY at a time).
 */
export async function fetchAllX402Transactions(
  limit: number = DEFAULT_LIMIT,
  options?: { backfill?: boolean },
): Promise<{ transactions: Omit<Transaction, 'id'>[]; paysh: PayshExtractedPayment[] }> {
  const backfill = options?.backfill ?? false;

  // Iteration set: existing x402 facilitators + pay.sh operator addresses
  // (Track A2 — MPP-on-Solana coverage) + the AgentKarma specimen agent
  // (mainnet end-to-end exercise). Set-dedup handles overlaps where a
  // pay.sh operator's feePayer is already a known x402 facilitator.
  const iterationAddresses = [...new Set([
    ...ALL_FACILITATOR_ADDRESSES,
    ...PAYSH_OPERATOR_ADDRESSES,
    ...SPECIMEN_ADDRESSES,
  ])];

  const results = await withConcurrency(
    iterationAddresses,
    FACILITATOR_CONCURRENCY,
    async (address) => {
      // Load cursor for incremental indexing (skip in backfill mode)
      let until: string | undefined;
      if (!backfill) {
        const cursor = await getCursor(address);
        if (cursor) until = cursor.last_signature;
      }

      const result = await fetchTransactionsForFacilitator(address, limit, { until });

      // Save cursor for next run (newest signature from this batch)
      if (result.latestSignature && !backfill) {
        await upsertCursor(address, result.latestSignature);
      }

      return result;
    },
  );

  const allTxs = results.flatMap((r) => r.transactions);
  const allPaysh = results.flatMap((r) => r.paysh);
  console.log(
    `[indexer] Total x402 transactions fetched: ${allTxs.length}` +
    (allPaysh.length > 0 ? ` (${allPaysh.length} pay.sh-routed)` : ''),
  );
  return { transactions: allTxs, paysh: allPaysh };
}

// ─── Indexer Run ─────────────────────────────────────────────────────────────

export interface IndexerOptions {
  backfill?: boolean;
}

/**
 * Full indexer run: fetch all x402 transactions, persist to DB,
 * recalculate scores, and update wallet records.
 */
export async function runIndexer(
  limit: number = DEFAULT_LIMIT,
  options?: IndexerOptions,
): Promise<{
  fetched: number;
  inserted: number;
  scored: number;
  payshSignals: number;
}> {
  console.log(`[indexer] Starting ${options?.backfill ? 'backfill' : 'incremental'} indexer run...`);

  const { transactions, paysh } = await fetchAllX402Transactions(limit, options);
  if (transactions.length === 0 && paysh.length === 0) {
    console.log('[indexer] No new transactions found');
    return { fetched: 0, inserted: 0, scored: 0, payshSignals: 0 };
  }

  // Ensure wallet records exist before inserting transactions (FK constraint).
  // Includes pay.sh-routed payer wallets so the FK on signal_events resolves.
  const uniqueWallets = [...new Set([
    ...transactions.map((tx) => tx.wallet_address),
    ...paysh.map((p) => p.wallet),
  ])];
  console.log(`[indexer] Creating ${uniqueWallets.length} wallet records...`);
  for (const addr of uniqueWallets) {
    await upsertWallet(addr, 0, 'Unrated', 0);
  }

  const inserted = await insertTransactions(transactions);
  console.log(`[indexer] Inserted ${inserted}/${transactions.length} transactions`);

  // Emit Tier 2 behavioral signals for every payment (idempotent via (agent,kind,tx_ref)).
  const signalsInserted = await insertSignalEvents(buildX402PaymentSignals(transactions));
  if (signalsInserted > 0) console.log(`[indexer] Emitted ${signalsInserted} Tier 2 signal_events`);

  // Emit Tier 1 paysh_routed signals (sprint A1). Idempotent on tx_signature.
  let payshSignalsInserted = 0;
  if (paysh.length > 0) {
    const payshSignals: InsertSignalEventInput[] = paysh.map((p) =>
      buildPayshRoutedSignal({
        walletAddress: p.wallet,
        txSignature: p.txSignature,
        operatorAddress: p.operatorAddress,
        operatorId: p.operatorId,
        protocol: p.protocol,
        observedAt: p.observedAt,
      }),
    );
    payshSignalsInserted = await insertSignalEvents(payshSignals);
    if (payshSignalsInserted > 0) {
      console.log(`[indexer] Emitted ${payshSignalsInserted} Tier 1 paysh_routed signal_events`);
    }
  }

  // Re-query full DB history for affected wallets so scores reflect ALL transactions
  const affectedWallets = uniqueWallets;
  console.log(`[indexer] Fetching full history for ${affectedWallets.length} affected wallets...`);
  const allTxsForAffected = await getTransactionsForWallets(affectedWallets);

  // Fetch 8004 attestations for affected wallets
  const attestations = await readAttestations(affectedWallets);
  if (attestations.size > 0) {
    console.log(`[indexer] Found ${attestations.size} 8004 attestations`);
  }

  // Emit Tier 2 cadence + Autonomy Confidence signals for affected wallets.
  const txByWallet = new Map<string, typeof allTxsForAffected>();
  for (const tx of allTxsForAffected) {
    const list = txByWallet.get(tx.wallet_address) ?? [];
    list.push(tx);
    txByWallet.set(tx.wallet_address, list);
  }
  const cadenceSignals = [];
  const autonomySignals = [];
  const cadenceScores = new Map<string, number>();
  const autonomyByWallet = new Map<string, AutonomyResult>();
  for (const [addr, txs] of txByWallet) {
    const cadence = computeCadence(txs.map((tx) => new Date(tx.timestamp)));
    if (cadence) {
      cadenceSignals.push(buildCadenceSignal(addr, cadence));
      cadenceScores.set(addr, cadence.automationScore);
    }
    const autonomy = computeAutonomy(
      txs.map((tx) => ({ timestamp: tx.timestamp, counterparty: tx.facilitator })),
    );
    if (autonomy) {
      autonomySignals.push(buildAutonomySignal(addr, autonomy));
      autonomyByWallet.set(addr, autonomy);
    }
  }
  if (cadenceSignals.length > 0) {
    await insertSignalEvents(cadenceSignals, { overwrite: true });
    console.log(`[indexer] Emitted ${cadenceSignals.length} cadence signals`);
  }
  if (autonomySignals.length > 0) {
    await insertSignalEvents(autonomySignals, { overwrite: true });
    console.log(`[indexer] Emitted ${autonomySignals.length} autonomy signals`);
  }

  // Load Tier 3 manifest scores (Phase H1) — already-resolved manifests contribute
  // to the blended score; wallets with no manifest get null and weight redistributes.
  const manifestScores = await getLatestSignalValues(affectedWallets, 'manifest');

  // Pay.sh-routed counts feed Tier 1 alongside 8004 + feedback. Counts are
  // pulled from signal_events so the score reflects historical receipts even
  // when this run found zero new pay.sh hits.
  const payshCounts = await countSignalEventsByKind(affectedWallets, 'paysh_routed');
  if (payshCounts.size > 0) {
    console.log(`[indexer] ${payshCounts.size} wallets have pay.sh-routed receipts in history`);
  }

  const scores = calculateScores(allTxsForAffected, attestations, cadenceScores, manifestScores, payshCounts);

  let scored = 0;
  for (const [address, walletScore] of scores) {
    const autonomy = autonomyByWallet.get(address);
    await upsertWallet(address, walletScore.score, walletScore.trustTier, walletScore.txCount, {
      providerScore: walletScore.providerScore,
      consumerScore: walletScore.consumerScore,
      confidenceBadge: walletScore.confidenceBadge,
      autonomyScore: autonomy?.score ?? null,
      autonomyLabel: autonomy?.label ?? null,
      metricSuccessRate: walletScore.metrics.successRate,
      metricDiversity:   walletScore.metrics.diversity,
      metricVolume:      walletScore.metrics.volume,
      metricAge:         walletScore.metrics.age,
      metricCadence:     walletScore.metrics.cadence,
    });
    await insertScoreSnapshot(
      address,
      walletScore.score,
      walletScore.metrics.successRate,
      walletScore.metrics.diversity,
      walletScore.metrics.volume,
      walletScore.metrics.age,
    );
    scored++;
  }

  console.log(`[indexer] Scored ${scored} wallets`);
  return { fetched: transactions.length, inserted, scored, payshSignals: payshSignalsInserted };
}

// Re-export type for downstream callers (webhooks, scripts, etc.)
export type { HeliusEnhancedTransaction };
