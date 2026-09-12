/** Mainnet native-USDC observations. Payment movement is behavioral evidence,
 * never proof of service delivery or an attestation. No transaction rows are
 * synthesized to pass through the legacy payment scoring adapter. */
import { formatUnits } from 'viem';
import type { ConfidenceBadge, SignalEvent } from '@/db/schema';
import { calculateTieredScore, evidenceGatedTier, recencyDecay, type TrustTier } from './index';
import {
  ARC_MAINNET_TRANSFER_DECIMALS, ARC_MAINNET_TRANSFER_EMITTER,
  ARC_MAINNET_TRANSFER_EXCLUSIONS,
} from '@/config/arc-mainnet';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const BURN_ADDRESS = '0x000000000000000000000000000000000000dead';
export const ARC_MAINNET_RECEIPT_LIMIT = 10_000;

export interface ArcMainnetReceiptObservation {
  eventKey: string;
  rawTxHash: string;
  logIndex: number;
  face: 'provider' | 'consumer';
  counterparty: string;
  rawAmount: string;
  amountDecimal: string;
  timestamp: string;
}

function allowedAddress(address: string): boolean {
  return ADDRESS.test(address) && !ARC_MAINNET_TRANSFER_EXCLUSIONS.has(address) && address !== BURN_ADDRESS;
}

function validateReceipt(wallet: string, event: SignalEvent, now: number): ArcMainnetReceiptObservation | null {
  const p = event.payload;
  if (event.chain !== 'arc-mainnet' || event.agent_wallet?.toLowerCase() !== wallet
    || event.kind !== 'usdc_transfer_settled' || event.tier !== 2
    || (event.face !== 'provider' && event.face !== 'consumer') || !p) return null;
  const counterparty = typeof p.counterparty === 'string' ? p.counterparty.toLowerCase() : '';
  const rawTxHash = typeof p.rawTxHash === 'string' ? p.rawTxHash.toLowerCase() : '';
  if (!allowedAddress(counterparty) || counterparty === wallet
    || event.signed_by !== null || !HASH.test(rawTxHash)
    || p.source !== 'arc_native_usdc_transfer'
    || typeof p.emitter !== 'string' || p.emitter.toLowerCase() !== ARC_MAINNET_TRANSFER_EMITTER
    || p.decimals !== ARC_MAINNET_TRANSFER_DECIMALS
    || !Number.isSafeInteger(p.logIndex) || (p.logIndex as number) < 0
    || typeof p.rawAmount !== 'string' || !/^[1-9][0-9]{0,37}$/.test(p.rawAmount)) return null;
  const amount = BigInt(p.rawAmount);
  const amountDecimal = formatUnits(amount, ARC_MAINNET_TRANSFER_DECIMALS);
  const eventKey = `${rawTxHash}:${p.logIndex}`;
  const time = typeof event.observed_at === 'string' ? Date.parse(event.observed_at) : NaN;
  if (p.amountDecimal !== amountDecimal || typeof p.amount !== 'number'
    || !Number.isFinite(p.amount) || p.amount !== Number(amountDecimal)
    || event.tx_ref?.toLowerCase() !== eventKey
    || !/T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(event.observed_at)
    || !Number.isFinite(time) || time < 0 || time > now) return null;
  return { eventKey, rawTxHash, logIndex: p.logIndex as number, face: event.face,
    counterparty, rawAmount: p.rawAmount, amountDecimal, timestamp: new Date(time).toISOString() };
}

/** Dedup by on-chain event identity, not row id. Conflicting copies are removed
 * altogether, so fetch order can never choose which account/value earns score. */
export function collectArcMainnetReceipts(
  rawWallet: string,
  events: readonly SignalEvent[],
  opts: { now?: Date } = {},
): { observations: ArcMainnetReceiptObservation[]; invalid: number } {
  const wallet = rawWallet.toLowerCase();
  const now = (opts.now ?? new Date()).getTime();
  if (!allowedAddress(wallet) || !Number.isFinite(now)) return { observations: [], invalid: events.length };
  const byEvent = new Map<string, ArcMainnetReceiptObservation>();
  const conflicts = new Set<string>();
  const transactionTimes = new Map<string, string>();
  const conflictingHashes = new Set<string>();
  let invalid = 0;
  for (const event of events) {
    const observation = validateReceipt(wallet, event, now);
    if (!observation) { invalid++; continue; }
    const time = transactionTimes.get(observation.rawTxHash);
    if (time && time !== observation.timestamp) conflictingHashes.add(observation.rawTxHash);
    transactionTimes.set(observation.rawTxHash, observation.timestamp);
    if (conflicts.has(observation.eventKey)) continue;
    const previous = byEvent.get(observation.eventKey);
    if (previous && JSON.stringify(previous) !== JSON.stringify(observation)) {
      byEvent.delete(observation.eventKey);
      conflicts.add(observation.eventKey);
      invalid++;
    } else {
      byEvent.set(observation.eventKey, observation);
    }
  }
  const observations = [...byEvent.values()].filter(row => {
    if (conflictingHashes.has(row.rawTxHash)) { invalid++; return false; }
    return true;
  });
  return { observations: observations.sort((a, b) => a.eventKey.localeCompare(b.eventKey)), invalid };
}

export interface ArcMainnetReceiptFace {
  face: 'provider' | 'consumer';
  score: number;
  trustTier: TrustTier;
  confidenceBadge: ConfidenceBadge;
  hasSignal: boolean;
  metrics: Record<string, number> | null;
  tierAggregates: Record<string, number | null>;
}

export interface ArcMainnetReceiptScore {
  provider: ArcMainnetReceiptFace;
  consumer: ArcMainnetReceiptFace;
  txCount: number;
  lastActive: string | null;
  evidence: {
    model: 'arc-mainnet-transfers-v1';
    received: number;
    sent: number;
    invalid: number;
    sampledEvents: number;
    sampleLimit: number;
    saturated: boolean;
    windowStart: string | null;
    windowEnd: string | null;
    matchedReciprocalRawAmount: string;
  };
  observations: ArcMainnetReceiptObservation[];
}

const DAY = 86_400_000;

/** Behavior-only, symmetric face recipe. Observed reciprocal value is
 * proportionally discounted; that guard is not independence or Sybil proof.
 * Breadth/activity count transaction hashes, never the number of transfer logs.
 * Amount has no positive weight; exact raw units are used only for the guard. */
export function computeArcMainnetReceiptScore(
  wallet: string, events: readonly SignalEvent[], opts: { now?: Date; saturated?: boolean } = {},
): ArcMainnetReceiptScore {
  const now = opts.now ?? new Date();
  const { observations, invalid } = collectArcMainnetReceipts(wallet, events, { now });
  const received = observations.filter(row => row.face === 'provider');
  const sent = observations.filter(row => row.face === 'consumer');
  function totals(rows: ArcMainnetReceiptObservation[]) {
    const byCounterparty = new Map<string, bigint>();
    for (const row of rows) byCounterparty.set(row.counterparty,
      (byCounterparty.get(row.counterparty) ?? 0n) + BigInt(row.rawAmount));
    return byCounterparty;
  }
  const inbound = totals(received);
  const outbound = totals(sent);
  let matched = 0n;
  for (const [cp, amount] of inbound) {
    const reverse = outbound.get(cp) ?? 0n;
    matched += amount < reverse ? amount : reverse;
  }
  function faceScore(face: 'provider' | 'consumer', rows: ArcMainnetReceiptObservation[]): ArcMainnetReceiptFace {
    const total = rows.reduce((sum, row) => sum + BigInt(row.rawAmount), 0n);
    const retained = total - matched;
    const unique = new Map<string, ArcMainnetReceiptObservation>();
    for (const row of rows) if (!unique.has(row.rawTxHash)) unique.set(row.rawTxHash, row);
    const txCount = unique.size;
    const counterparties = Math.min(new Set(rows.map(row => row.counterparty)).size, txCount);
    const timestamps = [...unique.values()].map(row => Date.parse(row.timestamp));
    const first = timestamps.length ? Math.min(...timestamps) : now.getTime();
    const last = timestamps.length ? Math.max(...timestamps) : now.getTime();
    const days = (last - first) / DAY;
    const retainedValueShare = total > 0n ? Number(retained) / Number(total) : 0;
    const metrics = { breadth: Math.min(counterparties / 10, 1), activity: Math.min(txCount / 500, 1),
      continuity: Math.min(days / 180, 1), retainedValueShare,
      uniqueTransactions: txCount, uniqueCounterparties: counterparties, observedDays: days };
    const hasSignal = txCount > 0 && retained > 0n;
    const tier2 = hasSignal ? (0.5 * metrics.breadth + 0.3 * metrics.activity + 0.2 * metrics.continuity)
      * retainedValueShare : null;
    const tierAggregates = { tier1: null, tier2, tier3: null, tier4: null };
    const scored = calculateTieredScore(tierAggregates, { decay: recencyDecay((now.getTime() - last) / DAY) });
    return { face, score: scored.score, confidenceBadge: scored.confidenceBadge, hasSignal,
      trustTier: evidenceGatedTier(scored.score, { txCount, counterparties, daysActive: days,
        hasTier1Receipts: false, tier1Strong: false }), metrics: txCount ? metrics : null, tierAggregates };
  }
  return {
    provider: faceScore('provider', received), consumer: faceScore('consumer', sent),
    txCount: new Set(observations.map(row => row.rawTxHash)).size,
    lastActive: observations.length ? new Date(Math.max(...observations.map(row => Date.parse(row.timestamp)))).toISOString() : null,
    evidence: { model: 'arc-mainnet-transfers-v1', received: received.length, sent: sent.length,
      invalid, sampledEvents: events.length, sampleLimit: ARC_MAINNET_RECEIPT_LIMIT,
      saturated: opts.saturated ?? events.length >= ARC_MAINNET_RECEIPT_LIMIT,
      windowStart: observations.length ? new Date(Math.min(...observations.map(row => Date.parse(row.timestamp)))).toISOString() : null,
      windowEnd: observations.length ? new Date(Math.max(...observations.map(row => Date.parse(row.timestamp)))).toISOString() : null,
      matchedReciprocalRawAmount: matched.toString() }, observations,
  };
}
