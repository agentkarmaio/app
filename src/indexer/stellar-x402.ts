/**
 * Stellar x402 + MPP receipt indexer (U2).
 *
 * Reads SAC `transfer` events from Soroban RPC `getEvents`, attributes
 * consumer/provider/amount/success, and persists Tier-1 receipts:
 *   - x402: settlement tx is sourced by a known OZ Channels facilitator.
 *   - MPP Charge: per-request SAC transfer to a known MPP recipient.
 *   - MPP Channel: deposit (to channel C...) / close (from channel C...).
 *
 * Cursor = ledger sequence: last_signature = String(maxLedger), last_slot =
 * maxLedger. startLedger = cursor.last_slot + 1. Cursor key is namespaced by
 * the SAC contract id ("stellar:<SAC>").
 *
 * Soroban RPC keeps only ~7 days of events; deeper backfill falls back to
 * Horizon payments REST (backfillFromHorizon).
 *
 * New env vars:
 *   STELLAR_RPC_URL      — Soroban RPC endpoint (required, raises if absent).
 *   STELLAR_HORIZON_URL  — Horizon endpoint for backfill (optional).
 */

import { FeeBumpTransaction, rpc, scValToNative, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import type { Transaction } from '../db/schema';
import type { IndexRunResult } from '../chain-adapters/types';
import {
  getStellarUsdcSac,
  STELLAR_FACILITATOR_SET,
  STELLAR_MPP_RECIPIENTS,
  STELLAR_USDC_DECIMALS,
  isStellarContract,
  type StellarNetwork,
} from '../config/stellar-x402';
import {
  insertTransactions as dbInsertTransactions,
  insertSignalEvents as dbInsertSignalEvents,
  upsertWallet as dbUpsertWallet,
  getCursor as dbGetCursor,
  upsertCursor as dbUpsertCursor,
  type InsertSignalEventInput,
} from '../db/client';
import { buildPayshRoutedSignal } from '../scoring/signals';

// ── Raw RPC event shape (subset of @stellar/stellar-sdk rpc.Api.EventResponse) ─
export interface RawSorobanEvent {
  id: string;
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  topic: xdr.ScVal[];
  value: xdr.ScVal;
  txHash: string;
  /** Source account of the enclosing tx — the x402 facilitator for settlements. */
  txSourceAccount: string;
  txSuccessful: boolean;
}

export type StellarProtocol =
  | 'x402'
  | 'mpp_charge'
  | 'mpp_channel_deposit'
  | 'mpp_channel_close'
  | 'unknown';

export interface StellarTransferEvent {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  txSourceAccount: string;
  txSuccessful: boolean;
  from: string;
  to: string;
  rawAmount: bigint;
  amount: number;
  protocol: StellarProtocol;
}

const USDC_SCALE = 10 ** STELLAR_USDC_DECIMALS;

/**
 * Pure: decode a raw SAC event into a transfer record. Returns null if the
 * event is not a `transfer` (topic[0] must be the "transfer" Symbol). Protocol
 * is left 'unknown' here; classifyProtocol assigns it.
 */
export function parseTransferEvent(raw: RawSorobanEvent): StellarTransferEvent | null {
  if (raw.topic.length < 3) return null;
  const kind = scValToNative(raw.topic[0]);
  if (kind !== 'transfer') return null;

  const from = scValToNative(raw.topic[1]) as string;
  const to = scValToNative(raw.topic[2]) as string;
  const rawAmount = BigInt(scValToNative(raw.value) as bigint | number | string);
  const amount = Number(rawAmount) / USDC_SCALE;

  return {
    id: raw.id,
    ledger: raw.ledger,
    ledgerClosedAt: raw.ledgerClosedAt,
    txHash: raw.txHash,
    txSourceAccount: raw.txSourceAccount,
    txSuccessful: raw.txSuccessful,
    from,
    to,
    rawAmount,
    amount,
    protocol: 'unknown',
  };
}

// ─── Protocol classification ──────────────────────────────────────────────────

export interface ClassifySets {
  facilitators: ReadonlySet<string>;
  mppRecipients: ReadonlySet<string>;
}

/**
 * Pure: assign a protocol to a transfer. x402 (facilitator-sourced settlement)
 * takes precedence — the facilitator fee-bumps so its account is the tx source
 * even when the transfer lands in a channel contract.
 */
export function classifyProtocol(ev: StellarTransferEvent, sets: ClassifySets): StellarProtocol {
  if (sets.facilitators.has(ev.txSourceAccount)) return 'x402';
  if (isStellarContract(ev.to)) return 'mpp_channel_deposit';
  if (isStellarContract(ev.from)) return 'mpp_channel_close';
  if (sets.mppRecipients.has(ev.to)) return 'mpp_charge';
  return 'unknown';
}

// ─── Attribution + row mapping ────────────────────────────────────────────────

export interface TransferAttribution {
  /** Payer / consumer face. */
  consumer: string;
  /** Payee / provider face (channel contract for deposits/closes). */
  provider: string;
}

/**
 * Pure: derive consumer/provider faces. For every protocol the payer side is
 * `from` and the payee side is `to`. The mpp_channel_close branch is kept
 * explicit so a future close-specific attribution is a one-line change.
 */
export function attributeTransfer(ev: StellarTransferEvent): TransferAttribution {
  if (ev.protocol === 'mpp_channel_close') {
    return { consumer: ev.from, provider: ev.to };
  }
  return { consumer: ev.from, provider: ev.to };
}

/** Pure: map a transfer to an AK `transactions` row. */
export function toTransactionRow(ev: StellarTransferEvent): Omit<Transaction, 'id'> {
  return {
    chain: 'stellar',
    wallet_address: ev.from,
    facilitator: ev.txSourceAccount,
    amount: ev.amount,
    timestamp: ev.ledgerClosedAt,
    success: ev.txSuccessful,
    tx_signature: ev.txHash,
  };
}

// ─── DI core ──────────────────────────────────────────────────────────────────

export interface GetEventsPage {
  events: RawSorobanEvent[];
  latestLedger: number;
}

export interface StellarIndexerDeps {
  /** USDC SAC contract id whose transfer events we read. */
  sac: string;
  facilitators: ReadonlySet<string>;
  mppRecipients: ReadonlySet<string>;
  /** Injected Soroban RPC getEvents. `startLedger` is the first ledger to read. */
  getEvents: (startLedger: number, opts: { sac: string; limit: number }) => Promise<GetEventsPage>;
  insertTransactions: (rows: Omit<Transaction, 'id'>[]) => Promise<number>;
  insertSignalEvents: (inputs: InsertSignalEventInput[]) => Promise<number>;
  ensureWallet: (address: string) => Promise<void>;
  getCursor: (key: string) => Promise<{ last_signature: string; last_slot: number | null } | null>;
  upsertCursor: (key: string, lastSignature: string, lastSlot?: number) => Promise<void>;
  limit?: number;
}

const DEFAULT_EVENT_LIMIT = 200;
const GENESIS_FALLBACK_LEDGER = 1;

/** Cursor key is namespaced by SAC so it never collides with Solana facilitators. */
export function stellarCursorKey(sac: string): string {
  return `stellar:${sac}`;
}

function signalProtocol(p: StellarProtocol): 'x402' | 'mpp' | 'hybrid' {
  return p === 'x402' ? 'x402' : 'mpp';
}

/**
 * Index one pass of SAC transfer events. Pure orchestration over injected IO.
 * No-op when both the facilitator and MPP-recipient sets are empty.
 */
export async function stellarReceiptIndexer(deps: StellarIndexerDeps): Promise<IndexRunResult> {
  const cursors = new Map<string, string>();
  const limit = deps.limit ?? DEFAULT_EVENT_LIMIT;
  const cursorKey = stellarCursorKey(deps.sac);

  // Nothing to match against → skip the RPC round-trip entirely.
  if (deps.facilitators.size === 0 && deps.mppRecipients.size === 0) {
    return { fetched: 0, inserted: 0, cursors };
  }

  // Resolve start ledger from cursor (last_slot + 1), else genesis fallback.
  let startLedger = GENESIS_FALLBACK_LEDGER;
  const cursor = await deps.getCursor(cursorKey);
  if (cursor?.last_slot != null) startLedger = cursor.last_slot + 1;

  const page = await deps.getEvents(startLedger, { sac: deps.sac, limit });

  const sets: ClassifySets = { facilitators: deps.facilitators, mppRecipients: deps.mppRecipients };
  const rows: Omit<Transaction, 'id'>[] = [];
  const signals: InsertSignalEventInput[] = [];
  const wallets = new Set<string>();
  let maxLedger = startLedger - 1;

  for (const raw of page.events) {
    const ev = parseTransferEvent(raw);
    if (!ev) continue;
    if (ev.ledger > maxLedger) maxLedger = ev.ledger;

    ev.protocol = classifyProtocol(ev, sets);
    if (ev.protocol === 'unknown') continue;

    const { consumer, provider } = attributeTransfer(ev);
    rows.push(toTransactionRow(ev));
    wallets.add(consumer);
    wallets.add(provider);

    // Tier-1 receipt pair — same canonical builder the Solana indexer uses
    // (consumer credits the payer, provider credits the operator).
    signals.push(
      buildPayshRoutedSignal({
        walletAddress: consumer, face: 'consumer', txSignature: ev.txHash,
        operatorAddress: provider, protocol: signalProtocol(ev.protocol), observedAt: ev.ledgerClosedAt,
        payerWallet: consumer,
      }),
      buildPayshRoutedSignal({
        walletAddress: provider, face: 'provider', txSignature: ev.txHash,
        operatorAddress: provider, protocol: signalProtocol(ev.protocol), observedAt: ev.ledgerClosedAt,
        payerWallet: consumer,
      }),
    );
  }

  const fetched = rows.length;
  if (fetched === 0) return { fetched: 0, inserted: 0, cursors };

  // FK pre-create both faces before inserting transactions / signal_events.
  for (const w of wallets) await deps.ensureWallet(w);

  const inserted = await deps.insertTransactions(rows);
  await deps.insertSignalEvents(signals);

  // Cursor = ledger sequence. last_signature = String(maxLedger), last_slot = maxLedger.
  const effectiveMax = page.events.length > 0 ? maxLedger : page.latestLedger;
  await deps.upsertCursor(cursorKey, String(effectiveMax), effectiveMax);
  cursors.set(cursorKey, String(effectiveMax));

  return { fetched, inserted, cursors };
}

// ─── Production wiring ──────────────────────────────────────────────────────

/** Public-network passphrase — fee-bump source extraction needs it to parse XDR. */
const PUBLIC_NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

function getRpcServer(): rpc.Server {
  const url = process.env.STELLAR_RPC_URL;
  if (!url) throw new Error('STELLAR_RPC_URL env var is not set'); // raise, no fallback
  return new rpc.Server(url);
}

function contractIdToString(contractId: rpc.Api.EventResponse['contractId']): string {
  if (!contractId) return '';
  return typeof contractId === 'string' ? contractId : contractId.address().toString();
}

/** Real Soroban RPC getEvents → RawSorobanEvent[]. Filters SAC `transfer` topic. */
async function rpcGetEvents(
  startLedger: number,
  opts: { sac: string; limit: number },
): Promise<GetEventsPage> {
  const server = getRpcServer();
  const transferTopic = xdr.ScVal.scvSymbol('transfer').toXDR('base64');
  const resp = await server.getEvents({
    startLedger,
    filters: [{ type: 'contract', contractIds: [opts.sac], topics: [[transferTopic, '*', '*']] }],
    limit: opts.limit,
  });
  const events: RawSorobanEvent[] = resp.events.map((e) => ({
    id: e.id,
    type: e.type,
    ledger: e.ledger,
    ledgerClosedAt: e.ledgerClosedAt,
    contractId: contractIdToString(e.contractId),
    topic: e.topic,
    value: e.value,
    txHash: e.txHash,
    // RPC EventResponse carries no source_account; resolved in rpcResolveSources.
    txSourceAccount: '',
    txSuccessful: e.inSuccessfulContractCall,
  }));
  return { events, latestLedger: resp.latestLedger };
}

/**
 * Resolve each event's enclosing-tx source account + success via getTransaction.
 * Mutates events in place. De-dupes by txHash to bound the RPC fan-out. The
 * fee-bump outer source (the facilitator) is read from the envelope XDR; a
 * non-fee-bump tx falls back to its own source account.
 */
async function rpcResolveSources(events: RawSorobanEvent[]): Promise<void> {
  const server = getRpcServer();
  const passphrase = process.env.STELLAR_NETWORK_PASSPHRASE ?? PUBLIC_NETWORK_PASSPHRASE;
  const byHash = new Map<string, RawSorobanEvent[]>();
  for (const e of events) {
    const list = byHash.get(e.txHash) ?? [];
    list.push(e);
    byHash.set(e.txHash, list);
  }
  for (const [hash, group] of byHash) {
    try {
      const tx = await server.getTransaction(hash);
      const success = tx.status === rpc.Api.GetTransactionStatus.SUCCESS;
      let source = '';
      if (
        tx.status === rpc.Api.GetTransactionStatus.SUCCESS ||
        tx.status === rpc.Api.GetTransactionStatus.FAILED
      ) {
        const envelopeXdr = tx.envelopeXdr.toXDR('base64');
        const built = TransactionBuilder.fromXDR(envelopeXdr, passphrase);
        source = built instanceof FeeBumpTransaction ? built.feeSource : built.source;
      }
      for (const e of group) { e.txSourceAccount = source; e.txSuccessful = success; }
    } catch (err) {
      console.error(`[stellar-indexer] getTransaction failed for ${hash}:`, err);
      // Leave source empty → event classifies 'unknown' and is skipped. No throw.
    }
  }
}

/**
 * Production indexer run. Reads the pubnet USDC SAC by default.
 * Raises on missing STELLAR_RPC_URL (no silent fallback).
 */
export async function runStellarIndexer(
  opts: { network?: StellarNetwork; limit?: number } = {},
): Promise<IndexRunResult> {
  const network = opts.network ?? 'pubnet';
  const sac = getStellarUsdcSac(network);
  return stellarReceiptIndexer({
    sac,
    facilitators: STELLAR_FACILITATOR_SET,
    mppRecipients: STELLAR_MPP_RECIPIENTS,
    limit: opts.limit,
    getEvents: async (start, o) => {
      const page = await rpcGetEvents(start, o);
      await rpcResolveSources(page.events);
      return page;
    },
    insertTransactions: dbInsertTransactions,
    insertSignalEvents: dbInsertSignalEvents,
    ensureWallet: async (a) => { await dbUpsertWallet(a, 0, 'Unrated', 0, {}, 'stellar'); },
    getCursor: async (key) => {
      const c = await dbGetCursor(key, 'stellar');
      return c ? { last_signature: c.last_signature, last_slot: c.last_slot } : null;
    },
    upsertCursor: async (key, last, slot) => { await dbUpsertCursor(key, last, slot, 'stellar'); },
  });
}

/**
 * Horizon backfill fallback (spec §4). For history beyond RPC's ~7-day getEvents
 * window, walk facilitator payments via Horizon REST. Cursor is the Horizon
 * paging_token, stored in last_signature.
 */
export async function backfillFromHorizon(opts: {
  facilitator: string;
  horizonUrl?: string;
  cursor?: string;
  limit?: number;
}): Promise<{ rows: Omit<Transaction, 'id'>[]; nextCursor: string | null }> {
  const base = opts.horizonUrl ?? process.env.STELLAR_HORIZON_URL ?? 'https://horizon.stellar.org';
  const limit = opts.limit ?? 200;
  const url = new URL(`${base}/accounts/${opts.facilitator}/payments`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('order', 'asc');
  if (opts.cursor) url.searchParams.set('cursor', opts.cursor);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Horizon backfill failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as {
    _embedded: { records: Array<{
      type: string; from?: string; to?: string; amount?: string;
      transaction_hash: string; created_at: string; paging_token: string;
      asset_code?: string; transaction_successful?: boolean;
    }> };
  };

  const records = body._embedded.records;
  const rows: Omit<Transaction, 'id'>[] = [];
  let nextCursor: string | null = null;
  for (const r of records) {
    nextCursor = r.paging_token;
    if (r.type !== 'payment' || r.asset_code !== 'USDC' || !r.from || !r.amount) continue;
    rows.push({
      chain: 'stellar',
      wallet_address: r.from,
      facilitator: opts.facilitator,
      amount: Number(r.amount),
      timestamp: r.created_at,
      success: r.transaction_successful ?? true,
      tx_signature: r.transaction_hash,
    });
  }
  return { rows, nextCursor };
}
