/**
 * Karma Indexer — Fetches x402 USDC payment transactions from Solana
 * for all known facilitator addresses.
 *
 * Uses Helius Enhanced Transactions API for batch parsing (fast),
 * with cursor-based incremental indexing and parallel facilitator fetching.
 *
 * Env:
 *   SOLANA_RPC_URL         — indexer RPC (a free standard endpoint; preferred)
 *   HELIUS_RPC_URL         — fallback RPC when SOLANA_RPC_URL is unset
 *   SOLANA_ARCHIVE_RPC_URL — full-history RPC for transactions the indexer RPC
 *                            has already pruned. Defaults to public mainnet-beta,
 *                            so this works with no configuration.
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
  ensureWalletsExist,
  insertScoreSnapshot,
  getTransactionsForWallets,
  DEFAULT_TX_WINDOW,
  getCursor,
  upsertCursor,
  insertSignalEvents,
  getLatestSignalValues,
  getPayshOperatorReceiptStats,
  type InsertSignalEventInput,
} from '../db/client';
import { calculateScores } from '../scoring';
import { calculateOperatorScore } from '../scoring/operator';
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
  getIndexerRpcUrl,
  type HeliusEnhancedTransaction,
  type PayshExtractedPayment,
} from './helius';
import { withConcurrency } from '@/lib/concurrency';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 100;
const FACILITATOR_CONCURRENCY = 5;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getConnection(): Connection {
  // Free-RPC-first (getIndexerRpcUrl): set SOLANA_RPC_URL to run Helius-free.
  return new Connection(getIndexerRpcUrl(), 'confirmed');
}

/**
 * True for RPC rate-limit / quota-exhaustion errors (Helius `429` /
 * `-32429 "max usage reached"`). On these, continuing to poll the remaining
 * ~75 facilitators just 429s every call — spamming logs and burning more quota.
 * The run trips a circuit breaker and resumes cleanly next tick (cursors for
 * skipped facilitators are never advanced).
 */
export function isRpcRateLimited(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('429') ||
    msg.includes('-32429') ||
    msg.includes('max usage reached') ||
    msg.includes('Too Many Requests') ||
    msg.includes('rate limit')
  );
}

/**
 * True when the RPC cannot resolve the `until` cursor signature we sent
 * (JSON-RPC `-32020`, "Transaction <sig> not found").
 *
 * Free/standard RPCs keep only shallow signature history, so a stored cursor
 * ages out and becomes permanently unresolvable ON THAT ENDPOINT. Unlike a
 * rate limit this never heals by waiting: every subsequent tick re-sends the
 * same dead cursor, gets the same error, indexes nothing, and — because the
 * cursor only advances on success — stays wedged forever. That is exactly how
 * Solana ingest silently stalled for 72h on 2026-07-22.
 *
 * Deliberately narrow: rate limits and transport errors must NOT match, since
 * their recovery is "back off and retry the same cursor", not "drop it".
 */
export function isCursorUnresolvable(err: unknown): boolean {
  if (isRpcRateLimited(err)) return false;
  if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === -32020) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('-32020') || /Transaction\s+\S+\s+not found/.test(msg);
}

/**
 * Fetch signatures, self-healing a cursor the RPC can no longer resolve.
 *
 * On an unresolvable `until`, retry ONCE without it. The caller then stores the
 * newest returned signature, so the cursor re-anchors inside the endpoint's
 * retained history and the next tick is incrementally correct again.
 *
 * Takes the fetch as a callback so the recovery policy is testable without an
 * RPC. Any other error (rate limit, transport) propagates untouched — those are
 * the circuit breaker's business, and burning a good cursor on them would open
 * a gap.
 */
export async function getSignaturesWithCursorFallback(
  fetchSignatures: (
    opts: { limit: number; until?: string; before?: string },
  ) => Promise<ConfirmedSignatureInfo[]>,
  opts: { limit: number; until?: string; before?: string },
): Promise<{ signatures: ConfirmedSignatureInfo[]; cursorReset: boolean }> {
  try {
    return { signatures: await fetchSignatures(opts), cursorReset: false };
  } catch (err) {
    if (!opts.until || !isCursorUnresolvable(err)) throw err;
    const { until: _dead, ...withoutCursor } = opts;
    void _dead;
    return { signatures: await fetchSignatures(withoutCursor), cursorReset: true };
  }
}

/**
 * What a cursor re-anchor actually means for THIS address, given how many
 * signatures the cursor-less retry returned.
 *
 * The old message fired identically in both cases and prescribed
 * `keep-fresh:backfill` — which was measured on 2026-09-10 to be incapable of
 * recovering any of it: every affected gap is 59-81 days old and the indexer RPC
 * retains ~2 days. An alert that names an impossible remedy is worse than none.
 *
 * `zero-signatures` is the common case here: all 16 re-anchoring facilitators
 * have been quiet longer than the endpoint's retention, so the retry returns
 * nothing, no cursor is stored, and the identical -32020 repeats next run. The
 * dead cursor is KEPT on purpose — it is the only record of where the gap
 * begins, and `backfill-facilitator-gap` needs it to page back to.
 *
 */
export function describeCursorReset(
  address: string,
  deadCursor: string | undefined,
  signatureCount: number,
): { level: 'info' | 'warn'; kind: 'zero-signatures' | 're-anchored'; message: string } {
  if (signatureCount === 0) {
    return {
      level: 'info',
      kind: 'zero-signatures',
      message:
        `[indexer] ${address}: no signatures within this RPC's retention window — ` +
        'nothing ingested, cursor kept as the gap anchor. Run ' +
        '`bun run scripts/backfill-facilitator-gap.ts --address ' + address + '` ' +
        'to measure what is behind it.',
    };
  }
  return {
    level: 'warn',
    kind: 're-anchored',
    message:
      `[indexer] ${address}: stored cursor ${deadCursor} is outside this RPC's history — ` +
      `re-anchored to the newest ${signatureCount} signature(s). Anything between the two ` +
      'is now unreachable incrementally; recover it with ' +
      '`bun run scripts/backfill-facilitator-gap.ts --address ' + address + ' --write`.',
  };
}

/**
 * Next cursor for a fetched signature batch, given the signatures this run could
 * not obtain from any RPC.
 *
 * `signatures` is newest-first (`getSignaturesForAddress` order) and the cursor
 * is an exclusive `until`, so storing `signatures[i]` means the next run sees
 * only `0..i-1`. Anything at or below `i` is unreachable FOREVER — `until` never
 * looks back. That is why this takes the unresolved set: the old code stored
 * `signatures[0]` unconditionally, so every signature the RPC could not serve was
 * skipped by the parser *and* passed by the cursor, silently.
 *
 * Policy: anchor to the newest signature strictly OLDER than every unresolved
 * one, so the next run re-fetches all of them. Re-processing costs nothing —
 * `insertTransactions` upserts on `tx_signature` and `signal_events` on
 * `(agent_wallet, kind, tx_ref)`. When the oldest signature in the batch is
 * itself unresolved there is no safe anchor, so the cursor must not move at all.
 *
 * The hold is only good while the signature stays inside the fetched window:
 * the archive fallback in `parseTransactionsBatch` is what makes it durable.
 */
export function computeSafeCursor(
  signatures: string[],
  unresolved: ReadonlySet<string>,
): string | null {
  if (signatures.length === 0) return null;
  if (unresolved.size === 0) return signatures[0];

  // Newest-first ⇒ the LAST unresolved index is the oldest unresolved signature.
  let oldestUnresolvedIdx = -1;
  for (let i = signatures.length - 1; i >= 0; i--) {
    if (unresolved.has(signatures[i])) { oldestUnresolvedIdx = i; break; }
  }
  if (oldestUnresolvedIdx === -1) return signatures[0]; // none of them are ours

  return signatures[oldestUnresolvedIdx + 1] ?? null;
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
  /**
   * Where the stored cursor may safely move to — NOT necessarily the newest
   * signature. Null means "do not advance": something in this batch is still
   * owed. See computeSafeCursor.
   */
  cursor: string | null;
  /** Signatures no endpoint could serve. Non-empty ⇒ this run was lossy. */
  unresolved: string[];
  rateLimited: boolean;
}> {
  const connection = getConnection();
  const pubkey = new PublicKey(address);

  const sigOpts: { limit: number; until?: string; before?: string } = { limit };
  if (options?.until) sigOpts.until = options.until;
  if (options?.before) sigOpts.before = options.before;

  let signatures: ConfirmedSignatureInfo[];
  try {
    const fetched = await getSignaturesWithCursorFallback(
      (o) => connection.getSignaturesForAddress(pubkey, o),
      sigOpts,
    );
    signatures = fetched.signatures;
    if (fetched.cursorReset) {
      // Classified only now that the retry's size is known: "re-anchored" and
      // "this endpoint has nothing for this address" are different events with
      // different remedies, and the old message conflated them.
      const reset = describeCursorReset(address, options?.until, fetched.signatures.length);
      if (reset.level === 'warn') console.warn(reset.message);
      else console.log(reset.message);
    }
  } catch (err) {
    const rateLimited = isRpcRateLimited(err);
    if (!rateLimited) console.error(`[indexer] Failed to get signatures for ${address}:`, err);
    return { transactions: [], paysh: [], cursor: null, unresolved: [], rateLimited };
  }

  if (signatures.length === 0) {
    const name = getFacilitatorName(address) ?? 'unknown';
    console.log(`[indexer] ${address} (${name}): 0 new signatures`);
    return { transactions: [], paysh: [], cursor: null, unresolved: [], rateLimited: false };
  }

  const sigStrings = signatures.map((s) => s.signature);

  // Decode via standard RPC, with the archive endpoint covering anything the
  // primary has already pruned.
  const parsed = await parseTransactionsBatch(sigStrings);

  // The cursor may only pass signatures we actually obtained. Log the SIGNATURES,
  // not a count: recovery is a targeted archive re-parse, which needs them.
  const cursor = computeSafeCursor(sigStrings, new Set(parsed.unresolved));
  if (parsed.unresolved.length > 0) {
    console.warn(
      `[indexer] ${address}: ${parsed.unresolved.length}/${sigStrings.length} signatures ` +
      `unserved by every RPC — cursor held at ${cursor ?? '(unchanged)'}. ` +
      `Unresolved: ${parsed.unresolved.join(',')}`,
    );
  }

  const results: Omit<Transaction, 'id'>[] = [];
  const payshHits: PayshExtractedPayment[] = [];
  for (const tx of parsed.transactions) {
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
    (payshHits.length > 0 ? ` (+${payshHits.length} pay.sh-routed)` : '') +
    (parsed.recoveredFromArchive > 0 ? ` (+${parsed.recoveredFromArchive} from archive RPC)` : '') +
    (parsed.undecodable > 0 ? ` (${parsed.undecodable} meta-less)` : '') +
    (parsed.unresolved.length > 0 ? ` (${parsed.unresolved.length} UNRESOLVED)` : ''),
  );
  return {
    transactions: results,
    paysh: payshHits,
    cursor,
    unresolved: parsed.unresolved,
    rateLimited: false,
  };
}

/**
 * Fetch x402 transactions for ALL known facilitator addresses.
 * Uses stored cursors for incremental indexing unless backfill mode is set.
 * Processes facilitators in parallel (FACILITATOR_CONCURRENCY at a time).
 */
export async function fetchAllX402Transactions(
  limit: number = DEFAULT_LIMIT,
  options?: { backfill?: boolean },
): Promise<{
  transactions: Omit<Transaction, 'id'>[];
  paysh: PayshExtractedPayment[];
  /** Signatures no RPC could serve this run, across all facilitators. */
  unresolved: number;
}> {
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

  // Run-scoped circuit breaker: once the RPC reports rate/quota exhaustion,
  // stop polling the remaining facilitators this run (they would all 429 too).
  const breaker = { tripped: false };

  const results = await withConcurrency(
    iterationAddresses,
    FACILITATOR_CONCURRENCY,
    async (address) => {
      if (breaker.tripped) {
        return { transactions: [], paysh: [], cursor: null, unresolved: [], rateLimited: true };
      }

      // Load cursor for incremental indexing (skip in backfill mode)
      let until: string | undefined;
      if (!backfill) {
        const cursor = await getCursor(address);
        if (cursor) until = cursor.last_signature;
      }

      const result = await fetchTransactionsForFacilitator(address, limit, { until });

      if (result.rateLimited && !breaker.tripped) {
        breaker.tripped = true;
        console.warn(
          '[indexer] RPC rate/quota limit reached — circuit breaker tripped, ' +
          'skipping remaining facilitators this run (resumes next tick)',
        );
      }

      // Save cursor for next run. NOT `signatures[0]`: computeSafeCursor holds it
      // below anything this run failed to obtain, so a transaction the RPC could
      // not serve is retried instead of skipped past forever.
      if (result.cursor && !backfill) {
        await upsertCursor(address, result.cursor);
      }

      return result;
    },
  );

  const allTxs = results.flatMap((r) => r.transactions);
  const allPaysh = results.flatMap((r) => r.paysh);
  const unresolved = results.reduce((n, r) => n + r.unresolved.length, 0);
  console.log(
    `[indexer] Total x402 transactions fetched: ${allTxs.length}` +
    (allPaysh.length > 0 ? ` (${allPaysh.length} pay.sh-routed)` : '') +
    (unresolved > 0 ? ` · ${unresolved} signatures UNRESOLVED (cursors held)` : ''),
  );
  return { transactions: allTxs, paysh: allPaysh, unresolved };
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
  operatorsScored: number;
  /**
   * Signatures no RPC could serve. Non-zero ⇒ the run is DEGRADED, not clean:
   * cursors were held so the next run retries, but the hold only lasts while the
   * signature stays inside the fetched window. Callers must surface it.
   */
  unresolved: number;
}> {
  console.log(`[indexer] Starting ${options?.backfill ? 'backfill' : 'incremental'} indexer run...`);

  const { transactions, paysh, unresolved } = await fetchAllX402Transactions(limit, options);
  if (transactions.length === 0 && paysh.length === 0) {
    // Decoding nothing while owing `unresolved` signatures is precisely the
    // silent case — carry the count out rather than reporting an empty clean run.
    console.log('[indexer] No new transactions found');
    return { fetched: 0, inserted: 0, scored: 0, payshSignals: 0, operatorsScored: 0, unresolved };
  }

  // Ensure wallet records exist before inserting transactions/signal_events
  // (FK constraint). Three wallet roles touched here:
  //  - x402 payers (`transactions.wallet_address`)
  //  - pay.sh payer agents (`paysh[].wallet`) — face=consumer signal
  //  - pay.sh operator gateways (`paysh[].operatorAddress`) — face=provider signal
  const operatorAddresses = [...new Set(paysh.map((p) => p.operatorAddress))];
  const payerAddresses = [...new Set([
    ...transactions.map((tx) => tx.wallet_address),
    ...paysh.map((p) => p.wallet),
  ])];
  const uniqueWallets = [...new Set([...payerAddresses, ...operatorAddresses])];
  console.log(`[indexer] Ensuring ${uniqueWallets.length} wallet records (${operatorAddresses.length} operators)…`);
  // Insert-if-absent, one batched statement: existing rows keep their live
  // score/tx_count (a plain upsert here used to zero them until re-scoring).
  await ensureWalletsExist(uniqueWallets);

  const inserted = await insertTransactions(transactions);
  console.log(`[indexer] Inserted ${inserted}/${transactions.length} transactions`);

  // Emit Tier 2 behavioral signals for every payment (idempotent via (agent,kind,tx_ref)).
  const signalsInserted = await insertSignalEvents(buildX402PaymentSignals(transactions));
  if (signalsInserted > 0) console.log(`[indexer] Emitted ${signalsInserted} Tier 2 signal_events`);

  // Emit Tier 1 paysh_routed signals (sprint A1, A2-fixed 2026-05-07).
  // TWO signals per pay.sh-routed tx:
  //   - face=consumer credits the payer (clean payment discipline)
  //   - face=provider credits the operator (delivered the call — broadcast IS attestation)
  // Same kind ('paysh_routed'), distinguished by agent_wallet + face. Existing
  // unique index (agent_wallet, kind, tx_ref) handles dedup naturally.
  let payshSignalsInserted = 0;
  if (paysh.length > 0) {
    const payshSignals: InsertSignalEventInput[] = paysh.flatMap((p) => [
      buildPayshRoutedSignal({
        walletAddress: p.wallet,           // payer
        face: 'consumer',
        txSignature: p.txSignature,
        operatorAddress: p.operatorAddress,
        operatorId: p.operatorId,
        protocol: p.protocol,
        observedAt: p.observedAt,
        payerWallet: p.wallet,
      }),
      buildPayshRoutedSignal({
        walletAddress: p.operatorAddress,  // operator (provider face)
        face: 'provider',
        txSignature: p.txSignature,
        operatorAddress: p.operatorAddress,
        operatorId: p.operatorId,
        protocol: p.protocol,
        observedAt: p.observedAt,
        payerWallet: p.wallet,
      }),
    ]);
    payshSignalsInserted = await insertSignalEvents(payshSignals);
    if (payshSignalsInserted > 0) {
      console.log(`[indexer] Emitted ${payshSignalsInserted} Tier 1 paysh_routed signal_events (consumer+provider pairs)`);
    }
  }

  // Main scoring loop runs only on wallets that have x402-style transactions.
  // Pay.sh operators have no transactions (they're recipients, not senders)
  // so they're filtered out here and scored separately in the operator pass below.
  const operatorSet = new Set(operatorAddresses);
  const affectedWallets = uniqueWallets.filter((a) => !operatorSet.has(a));
  console.log(
    `[indexer] Fetching up to ${DEFAULT_TX_WINDOW} recent txs each for ` +
    `${affectedWallets.length} affected wallets...`,
  );
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

  // NOTE: payshRoutedCount was previously passed here, but the legacy
  // attribution credited the payer's provider face — wrong direction (the
  // payer is the consumer in a pay.sh tx, the operator is the provider).
  // Consumer-face pay.sh signals are now emitted with face='consumer' and
  // will feed Consumer Karma in a future scoring revision. Operator-side
  // Provider Karma is computed in the operator pass below.
  const scores = calculateScores(allTxsForAffected, attestations, cadenceScores, manifestScores);

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

  // ─── Operator scoring pass (pay.sh provider-side Karma) ───────────────────
  // Operators have no `transactions` rows so the main calculateScores loop
  // skips them. We score them from their `paysh_routed` provider-face signals:
  // unique payer diversity + receipt volume + recency. See scoring/operator.ts.
  let operatorsScored = 0;
  const operatorsToScore = operatorAddresses;
  if (operatorsToScore.length > 0) {
    const operatorStats = await getPayshOperatorReceiptStats(operatorsToScore);
    for (const operator of operatorsToScore) {
      const stats = operatorStats.get(operator);
      if (!stats || stats.receiptCount === 0) continue;
      const op = calculateOperatorScore({
        receiptCount: stats.receiptCount,
        uniquePayerCount: stats.uniquePayerCount,
        lastSeen: stats.lastSeen,
      });
      await upsertWallet(operator, op.score, op.trustTier, stats.receiptCount, {
        providerScore: op.score,
        confidenceBadge: op.confidenceBadge,
      });
      operatorsScored++;
    }
    if (operatorsScored > 0) {
      console.log(`[indexer] Scored ${operatorsScored} pay.sh operators (provider-side)`);
    }
  }

  return {
    fetched: transactions.length,
    inserted,
    scored,
    payshSignals: payshSignalsInserted,
    operatorsScored,
    unresolved,
  };
}

// Re-export type for downstream callers (webhooks, scripts, etc.)
export type { HeliusEnhancedTransaction };
