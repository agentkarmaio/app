/**
 * Pure aggregation for the /arc grant-demo dashboard.
 *
 * AK-scored truth first: only matched ERC-8183 settlements (transactions written
 * by arc-jobs after JobCreated ⋈ PaymentReleased) and provider-face
 * erc8183_job_settled signals. Raw registry headcount is a secondary field —
 * never blended into quality.
 *
 * No DB / network here — unit-testable and safe to call from Server Components.
 */

import {
  computeSettlementQuality,
  ERC8183_SETTLED_KIND,
  type SettlementLabel,
  type SettlementReceipt,
} from '@/scoring/settlement-quality';

export interface ArcTxAggRow {
  amount: number | string;
  wallet_address: string;
  counterparty?: string | null;
}

export interface ArcSignalAggRow {
  agent_wallet: string;
  kind: string;
  face: string;
  signed_by?: string | null;
  payload?: unknown;
}

export interface ArcRecentSettlement {
  /** Composite jobId:txHash when available, else raw tx_signature. */
  txSignature: string;
  /** Bare 0x tx hash for explorer links (parsed from jobId:txHash). */
  txHash: string;
  walletAddress: string;
  counterparty: string | null;
  amount: number;
  timestamp: string;
}

export interface ArcQualityHistogram {
  reliable: number;
  mixed: number;
  unproven: number;
}

export interface ArcDashboardStats {
  matchedSettlements: number;
  volumeUsdc: number;
  /** Distinct providers with ≥1 matched settlement receipt. */
  agentsWithReceipts: number;
  quality: ArcQualityHistogram;
  recent: ArcRecentSettlement[];
  /**
   * Recent direct USDC payments (plain transfers, no escrow) whose PAYEE is a
   * registered ERC-8004 agent — e.g. AgentStack nanopayments via Circle Wallets.
   * Registered-payee membership filters out testnet transfer noise (0 of which
   * are in AK's ERC-8004 registry mirror). Distinct from `recent` (escrow only).
   */
  agentPayments: ArcRecentSettlement[];
  registry: { agents: number; feedbacks: number };
  /** True when AK has no matched settlements yet (honest empty dashboard). */
  empty: boolean;
}

const EMPTY_QUALITY: ArcQualityHistogram = { reliable: 0, mixed: 0, unproven: 0 };

/** Sum volume + distinct agent wallets that appear as client or provider on txs. */
export function aggregateArcTransactions(rows: ReadonlyArray<ArcTxAggRow>): {
  matchedSettlements: number;
  volumeUsdc: number;
  /** Distinct wallets on either side of a matched settlement. */
  distinctAgents: number;
} {
  let volumeUsdc = 0;
  const agents = new Set<string>();
  for (const row of rows) {
    const amount = Number(row.amount);
    if (Number.isFinite(amount)) volumeUsdc += amount;
    const client = row.wallet_address?.trim().toLowerCase();
    if (client) agents.add(client);
    const provider = row.counterparty?.trim().toLowerCase();
    if (provider) agents.add(provider);
  }
  return {
    matchedSettlements: rows.length,
    volumeUsdc,
    distinctAgents: agents.size,
  };
}

/**
 * Provider-face receipts → per-agent settlement quality → histogram.
 * Agents with zero receipts are omitted (computeSettlementQuality returns null).
 * Farmed wash patterns land in unproven.
 */
export function aggregateArcQuality(
  events: ReadonlyArray<ArcSignalAggRow>,
): ArcQualityHistogram {
  const byWallet = new Map<string, SettlementReceipt[]>();

  for (const e of events) {
    if (e.kind !== ERC8183_SETTLED_KIND || e.face !== 'provider') continue;
    const wallet = e.agent_wallet?.trim().toLowerCase();
    if (!wallet) continue;
    const payload = (e.payload ?? {}) as { counterparty?: unknown; amount?: unknown };
    const counterparty =
      e.signed_by
      ?? (typeof payload.counterparty === 'string' ? payload.counterparty : '')
      ?? '';
    const list = byWallet.get(wallet) ?? [];
    list.push({
      counterparty: counterparty || '',
      amount: typeof payload.amount === 'number' ? payload.amount : undefined,
    });
    byWallet.set(wallet, list);
  }

  const quality: ArcQualityHistogram = { ...EMPTY_QUALITY };
  for (const receipts of byWallet.values()) {
    const result = computeSettlementQuality(receipts);
    if (!result) continue;
    const label: SettlementLabel = result.label;
    quality[label] += 1;
  }
  return quality;
}

/** Count distinct providers that have ≥1 provider-face settlement signal. */
export function countAgentsWithReceipts(events: ReadonlyArray<ArcSignalAggRow>): number {
  const wallets = new Set<string>();
  for (const e of events) {
    if (e.kind !== ERC8183_SETTLED_KIND || e.face !== 'provider') continue;
    const wallet = e.agent_wallet?.trim().toLowerCase();
    if (wallet) wallets.add(wallet);
  }
  return wallets.size;
}

/**
 * Parse jobId:txHash composite used by arc-jobs. Bare hashes pass through.
 * Explorer links need the bare 0x hash.
 */
export function parseArcTxHash(txSignature: string): string {
  const idx = txSignature.indexOf(':0x');
  if (idx >= 0) return txSignature.slice(idx + 1);
  if (txSignature.startsWith('0x')) return txSignature;
  return txSignature;
}

export function mapRecentSettlements(
  rows: ReadonlyArray<{
    tx_signature: string;
    wallet_address: string;
    counterparty?: string | null;
    amount: number | string;
    timestamp: string;
  }>,
): ArcRecentSettlement[] {
  return rows.map((r) => ({
    txSignature: r.tx_signature,
    txHash: parseArcTxHash(r.tx_signature),
    walletAddress: r.wallet_address,
    counterparty: r.counterparty ?? null,
    amount: Number(r.amount) || 0,
    timestamp: r.timestamp,
  }));
}

/**
 * Filter plain-transfer rows to those whose PAYEE (counterparty) is a registered
 * ERC-8004 agent, then map + cap. `registeredWallets` is the lowercased set of
 * `agent_wallet`/`owner` addresses from the arc erc8004_agents mirror. This is
 * what isolates AgentStack-style agent-to-agent payments from testnet transfer
 * noise (noise payees are not in the mirror). Rows are assumed pre-ordered by
 * timestamp desc by the caller; we keep that order and take the first `limit`.
 */
export function filterAgentPayments(
  rows: ReadonlyArray<{
    tx_signature: string;
    wallet_address: string;
    counterparty?: string | null;
    amount: number | string;
    timestamp: string;
  }>,
  registeredWallets: ReadonlySet<string>,
  limit = 8,
): ArcRecentSettlement[] {
  const out: ArcRecentSettlement[] = [];
  for (const r of rows) {
    const payee = r.counterparty?.trim().toLowerCase();
    if (!payee || !registeredWallets.has(payee)) continue;
    out.push({
      txSignature: r.tx_signature,
      txHash: parseArcTxHash(r.tx_signature),
      walletAddress: r.wallet_address,
      counterparty: r.counterparty ?? null,
      amount: Number(r.amount) || 0,
      timestamp: r.timestamp,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export function emptyArcDashboardStats(
  registry: { agents: number; feedbacks: number } = { agents: 0, feedbacks: 0 },
): ArcDashboardStats {
  return {
    matchedSettlements: 0,
    volumeUsdc: 0,
    agentsWithReceipts: 0,
    quality: { ...EMPTY_QUALITY },
    recent: [],
    agentPayments: [],
    registry,
    empty: true,
  };
}
