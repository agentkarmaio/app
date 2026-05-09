/**
 * Wallet-side regressive history indexer.
 *
 * The facilitator-side indexer (src/indexer/index.ts) walks signatures from
 * each known x402 facilitator forward — fast for ongoing throughput, but it
 * misses historical receipts of newly-discovered wallets that paid through
 * facilitators whose cursors had already advanced past those sigs.
 *
 * `scanWalletHistory` walks BACKWARDS from the most-recent signature of a
 * given wallet (using `getSignaturesForAddress` paged via `before`), and on
 * each page:
 *   1. parses the txs via Helius Enhanced Transactions,
 *   2. checks each tx for an x402 USDC transfer where the counterparty is
 *      in the known-facilitator set,
 *   3. checks each tx for a pay.sh-routed fingerprint,
 *   4. persists hits idempotently (insertTransactions upserts on tx_signature;
 *      signal_events upsert on (agent_wallet, kind, tx_ref)).
 *
 * Termination is bounded by all of:
 *   - hard `maxSignatures` cap (2000 default → ~2 minutes of Helius parse),
 *   - `noiseFloorPages` consecutive zero-hit pages (5 → most agents finish),
 *   - history exhausted (page returned < pageSize).
 *
 * All DB-side and network-side IO is exposed as injectable hooks so the unit
 * tests can drive the algorithm deterministically without mounting Supabase
 * or Helius. The production worker (`runWalletScanWorker`) wires the real
 * helpers from `db/client` and `helius`.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import {
  ALL_FACILITATOR_ADDRESSES_SET,
} from '../config/facilitators';
import {
  parseTransactionsBatch as defaultParseTransactionsBatch,
  extractX402PaymentForWallet,
  extractPayshPayment,
  withConcurrency,
  type HeliusEnhancedTransaction,
  type PayshExtractedPayment,
} from './helius';
import {
  insertTransactions as dbInsertTransactions,
  insertSignalEvents as dbInsertSignalEvents,
  upsertWallet as dbUpsertWallet,
  getCursor as dbGetCursor,
  upsertCursor as dbUpsertCursor,
  markWalletsDirty as dbMarkWalletsDirty,
  claimWalletScans as dbClaimWalletScans,
  markWalletScanComplete as dbMarkWalletScanComplete,
  markWalletScanFailed as dbMarkWalletScanFailed,
} from '../db/client';
import { buildPayshRoutedSignal } from '../scoring/signals';
import type { Transaction } from '../db/schema';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SignatureRecord {
  signature: string;
  blockTime?: number | null;
}

export interface ScanOpts {
  pageSize?: number;
  maxSignatures?: number;
  noiseFloorPages?: number;
  // ── Network / IO injection (test mode skips everything DB-side) ─────────
  getSignaturesForAddress?: (
    address: string,
    pageOpts: { limit: number; before?: string },
  ) => Promise<SignatureRecord[]>;
  parseTransactionsBatch?: (sigs: string[]) => Promise<HeliusEnhancedTransaction[]>;
  insertTransactions?: (txs: Omit<Transaction, 'id'>[]) => Promise<number>;
  recordPayshSignal?: (paysh: PayshExtractedPayment) => Promise<void>;
  // ── Cursor IO — also injectable so tests skip Supabase ──────────────────
  getCursor?: (key: string) => Promise<{ last_signature: string } | null>;
  upsertCursor?: (key: string, lastSignature: string, lastSlot?: number | null) => Promise<void>;
  // ── Side effects on completion ─────────────────────────────────────────
  markDirty?: (addresses: string[]) => Promise<void>;
  // ── Defensive FK pre-create ─────────────────────────────────────────────
  ensureWallet?: (address: string) => Promise<void>;
}

export interface ScanResult {
  scanned: number;
  hits: number;
  reachedCap: boolean;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_SIGNATURES = 2000;
const DEFAULT_NOISE_FLOOR_PAGES = 5;
const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
const CURSOR_PREFIX = 'wallet_scan:';

let _connection: Connection | null = null;
function getConnection(): Connection {
  if (_connection) return _connection;
  const rpcUrl = process.env.HELIUS_RPC_URL ?? process.env.SOLANA_RPC_URL ?? DEFAULT_RPC;
  _connection = new Connection(rpcUrl, 'confirmed');
  return _connection;
}

async function defaultGetSignaturesForAddress(
  address: string,
  pageOpts: { limit: number; before?: string },
): Promise<SignatureRecord[]> {
  const connection = getConnection();
  const pubkey = new PublicKey(address);
  const sigOpts: { limit: number; before?: string } = { limit: pageOpts.limit };
  if (pageOpts.before) sigOpts.before = pageOpts.before;
  const sigs = await connection.getSignaturesForAddress(pubkey, sigOpts);
  return sigs.map((s) => ({ signature: s.signature, blockTime: s.blockTime ?? null }));
}

async function defaultRecordPayshSignal(p: PayshExtractedPayment): Promise<void> {
  const signal = buildPayshRoutedSignal({
    walletAddress: p.wallet,
    txSignature: p.txSignature,
    operatorAddress: p.operatorAddress,
    operatorId: p.operatorId,
    protocol: p.protocol,
    observedAt: p.observedAt,
  });
  await dbInsertSignalEvents([signal]);
}

// ─── Core scan ───────────────────────────────────────────────────────────────

export async function scanWalletHistory(
  wallet: string,
  opts: ScanOpts = {},
): Promise<ScanResult> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxSignatures = opts.maxSignatures ?? DEFAULT_MAX_SIGNATURES;
  const noiseFloorPages = opts.noiseFloorPages ?? DEFAULT_NOISE_FLOOR_PAGES;

  // Network/IO resolution. Stubs win; otherwise fall back to production
  // defaults. The cursor + markDirty + ensureWallet defaults are intentionally
  // left undefined — production callers wire them explicitly so unit tests
  // that pass none of them never touch Supabase.
  const fetchSignatures = opts.getSignaturesForAddress ?? defaultGetSignaturesForAddress;
  const parseBatch = opts.parseTransactionsBatch ?? defaultParseTransactionsBatch;
  const insertTxs = opts.insertTransactions ?? dbInsertTransactions;
  const recordPaysh = opts.recordPayshSignal ?? defaultRecordPayshSignal;

  // Defensive FK pre-create — only when caller wired it.
  if (opts.ensureWallet) {
    await opts.ensureWallet(wallet);
  }

  // Cursor read — only when caller wired it.
  let before: string | undefined;
  if (opts.getCursor) {
    const cursor = await opts.getCursor(CURSOR_PREFIX + wallet);
    if (cursor?.last_signature) before = cursor.last_signature;
  }

  let scanned = 0;
  let hits = 0;
  let consecutiveZeroHitPages = 0;
  let reachedCap = false;

  while (scanned < maxSignatures) {
    const remaining = maxSignatures - scanned;
    const limit = Math.min(pageSize, remaining);

    let sigs: SignatureRecord[];
    try {
      const fetchOpts: { limit: number; before?: string } = { limit };
      if (before) fetchOpts.before = before;
      sigs = await fetchSignatures(wallet, fetchOpts);
    } catch (err) {
      console.error(`[wallet-scan] getSignaturesForAddress failed for ${wallet}:`, err);
      throw err;
    }

    if (sigs.length === 0) break;

    // Parse this page's signatures via Helius. A partial-failure inside
    // parseTransactionsBatch returns fewer txs than sigs requested; that's
    // OK — we still advance the cursor past the whole page so the next run
    // doesn't redo the network round-trip for txs Helius already responded to.
    const sigStrings = sigs.map((s) => s.signature);
    let parsed: HeliusEnhancedTransaction[] = [];
    try {
      parsed = await parseBatch(sigStrings);
    } catch (err) {
      console.error(`[wallet-scan] parseTransactionsBatch failed for ${wallet}:`, err);
      // Don't rethrow yet — we still want to advance the cursor for sigs
      // we'd already accepted on prior pages. The current page is lost
      // until next run, but that's fine: history is immutable.
    }

    // Surface parse-loss so production drift is observable. Helius silently
    // drops txs it can't decode; if this ratio creeps up we want to notice.
    if (parsed.length < sigStrings.length) {
      console.warn(
        `[wallet-scan] ${wallet}: parsed ${parsed.length}/${sigStrings.length} signatures ` +
        `(${sigStrings.length - parsed.length} lost)`,
      );
    }

    const pageX402Hits: Omit<Transaction, 'id'>[] = [];
    const pagePayshHits: PayshExtractedPayment[] = [];

    for (const tx of parsed) {
      const x402 = extractX402PaymentForWallet(tx, wallet, ALL_FACILITATOR_ADDRESSES_SET);
      if (x402) pageX402Hits.push(x402.payment);

      const paysh = extractPayshPayment(tx);
      if (paysh && paysh.wallet === wallet) pagePayshHits.push(paysh);
    }

    if (pageX402Hits.length > 0) {
      try {
        await insertTxs(pageX402Hits);
      } catch (err) {
        console.error(`[wallet-scan] insertTransactions failed for ${wallet}:`, err);
        throw err;
      }
    }

    for (const p of pagePayshHits) {
      try {
        await recordPaysh(p);
      } catch (err) {
        console.error(`[wallet-scan] recordPayshSignal failed for ${wallet} sig=${p.txSignature}:`, err);
        throw err;
      }
    }

    const pageHits = pageX402Hits.length + pagePayshHits.length;
    scanned += sigs.length;
    hits += pageHits;
    consecutiveZeroHitPages = pageHits > 0 ? 0 : consecutiveZeroHitPages + 1;

    // Advance cursor at end of page. The oldest sig in this page becomes the
    // next `before` (Helius returns newest-first; oldest is the tail). Persist
    // the cursor even when this page contributed zero hits — the only goal of
    // the cursor is to avoid re-fetching sigs we've already considered.
    const tailSig = sigs[sigs.length - 1].signature;
    if (opts.upsertCursor) {
      try {
        await opts.upsertCursor(CURSOR_PREFIX + wallet, tailSig);
      } catch (err) {
        console.error(`[wallet-scan] upsertCursor failed for ${wallet}:`, err);
        // Soft-fail: cursor advance failure costs us re-fetching one page on
        // the next run. Non-fatal — keep scanning.
      }
    }
    before = tailSig;

    // Termination checks — order matters: cap before history-exhausted so we
    // don't double-flag a tail page that also crossed the limit.
    if (scanned >= maxSignatures) {
      reachedCap = true;
      break;
    }
    if (consecutiveZeroHitPages >= noiseFloorPages) break;
    if (sigs.length < limit) break; // history exhausted
  }

  if (hits > 0 && opts.markDirty) {
    try {
      await opts.markDirty([wallet]);
    } catch (err) {
      console.error(`[wallet-scan] markDirty failed for ${wallet}:`, err);
      // Non-fatal — the rescore worker will pick it up next sweep.
    }
  }

  return { scanned, hits, reachedCap };
}

// ─── Worker ──────────────────────────────────────────────────────────────────

// Note: stuck-scan recovery is the caller's responsibility — instrumentation.ts
// runs `recoverStuckScans` at the top of every tick using `WALLET_SCAN_STALE_MS`.

export async function runWalletScanWorker(batchSize = 1): Promise<void> {
  const addresses = await dbClaimWalletScans(batchSize);
  if (addresses.length === 0) {
    console.log('[wallet-scan-worker] No pending scans');
    return;
  }
  console.log(`[wallet-scan-worker] Claimed ${addresses.length} scan(s): ${addresses.join(', ')}`);

  // Production hook bundle. Concurrency stays at 1 — each scan can issue
  // hundreds of Helius parse calls; running them serially is friendlier to
  // both Helius rate limits and Supabase write throughput.
  let succeeded = 0;
  let failed = 0;
  await withConcurrency(addresses, 1, async (addr) => {
    try {
      const result = await scanWalletHistory(addr, {
        ensureWallet: async (a) => { await dbUpsertWallet(a, 0, 'Unrated', 0); },
        getCursor: async (key) => {
          const cursor = await dbGetCursor(key);
          return cursor ? { last_signature: cursor.last_signature } : null;
        },
        upsertCursor: async (key, lastSignature, lastSlot) => {
          await dbUpsertCursor(key, lastSignature, lastSlot ?? undefined);
        },
        markDirty: async (addrs) => { await dbMarkWalletsDirty(addrs); },
      });
      await dbMarkWalletScanComplete(addr, result.hits, result.reachedCap);
      succeeded++;
      console.log(
        `[wallet-scan-worker] ${addr}: scanned=${result.scanned} hits=${result.hits} reachedCap=${result.reachedCap}`,
      );
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[wallet-scan-worker] ${addr}: scan failed:`, err);
      await dbMarkWalletScanFailed(addr, msg.slice(0, 500));
    }
  });

  console.log(`[wallet-scan-worker] Done — ${succeeded} succeeded, ${failed} failed`);
}
