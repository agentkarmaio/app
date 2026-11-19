/**
 * Persists Stellar receipt display metrics (Txs / Active / Diversity) for every
 * chain='stellar' wallet row. Runs inside the stellar/transfers indexing lease,
 * right after ingestion, the same shape as refreshArcMainnetScores.
 *
 * It does not use the dirty queue. Pubnet Stellar never enqueues rescoring
 * (stellar-transfers.ts gates markDirty to testnet), because rescoreOne's
 * upsertWallet would also rewrite score, tier and badge. That is why Agent
 * Intern showed 6 transactions while 7 were stored. This refresh recomputes
 * from the full ledger on every run, so it cannot fall behind a missed mark.
 *
 * Only rows whose values changed are written. Success rate is cleared, never
 * computed: the Horizon walk only sees successful transfers.
 */
import { getIndexingHeaders } from '@/db/indexing-context';
import {
  getStellarReceiptRows,
  getStellarRegistryOwners,
  getStellarWalletDisplayRows,
  updateStellarDisplayMetrics,
  type StellarReceiptLedgerRow,
} from '@/db/client';
import { buildStellarOwnerGroups, computeStellarReceiptMetrics } from './stellar-receipt-metrics';

export interface StellarDisplayRefreshResult {
  wallets: number;
  updated: number;
}

const num = (v: number | string | null): number | null => (v == null ? null : Number(v));
const iso = (v: string | null): string | null => (v == null ? null : new Date(v).toISOString());

export async function refreshStellarDisplayMetrics(
  opts: { signal?: AbortSignal } = {},
): Promise<StellarDisplayRefreshResult> {
  // Writes share the transfers lease's fence. Outside that lease (a stray
  // script, a second worker) they must refuse, not race the owner.
  const guard = () => {
    opts.signal?.throwIfAborted();
    const h = getIndexingHeaders(); // throws once the lease is lost
    if (h['x-indexing-chain'] !== 'stellar' || h['x-indexing-path'] !== 'transfers' || !h['x-indexing-owner']) {
      throw new Error('stellar_transfers_lease_required');
    }
  };
  guard();
  const [rows, owners, wallets] = await Promise.all([
    getStellarReceiptRows(),
    getStellarRegistryOwners(),
    getStellarWalletDisplayRows(),
  ]);
  guard();

  // Index rows by both faces once: O(rows), not O(wallets × rows).
  const byAddress = new Map<string, StellarReceiptLedgerRow[]>();
  const push = (a: string | null, r: StellarReceiptLedgerRow) => {
    if (a == null) return;
    const list = byAddress.get(a);
    if (list) list.push(r); else byAddress.set(a, [r]);
  };
  for (const r of rows) {
    push(r.wallet_address, r);
    if (r.counterparty !== r.wallet_address) push(r.counterparty, r);
  }
  const groups = buildStellarOwnerGroups(owners);

  let updated = 0;
  for (const w of wallets) {
    const m = computeStellarReceiptMetrics(
      w.address, byAddress.get(w.address) ?? [], groups.get(w.address) ?? new Set([w.address]),
    );
    const unchanged = (w.tx_count ?? 0) === m.txCount
      && iso(w.last_seen) === m.lastSeen
      && num(w.metric_diversity) === m.diversity
      && w.metric_success_rate == null;
    if (unchanged) continue;
    guard();
    await updateStellarDisplayMetrics(w.address, {
      tx_count: m.txCount,
      last_seen: m.lastSeen,
      metric_diversity: m.diversity,
      metric_success_rate: null,
    });
    updated++;
  }
  return { wallets: wallets.length, updated };
}
