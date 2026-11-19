/**
 * Stellar receipt display metrics: Txs, Active and Diversity read from BOTH
 * directions of the `transactions` ledger.
 *
 * Why this exists: the legacy scorer reads `wallet_address = W` only, which is
 * the payer face. A Stellar agent that RECEIVES USDC has its receipts stored as
 * `counterparty = W` rows, and nothing ever read them. Its Explore columns stayed
 * empty while the data sat in the table (spec
 * docs/superpowers/specs/2026-11-19-stellar-inbound-receipt-metrics-design.md).
 *
 * Display metrics only. Karma, tier and badge are deliberately NOT derived here:
 * whether a plain transfer moves Stellar Karma is a separate scoring decision.
 * Success rate is not derived either. The Horizon payments walk only records
 * successful transfers, so a rate computed from them would read 100% everywhere.
 */
import { NORMALIZE } from './index';

export interface StellarReceiptRow {
  tx_signature: string;
  /** Payer. */
  wallet_address: string;
  /** Payee; null when the decoder could not attribute one. */
  counterparty: string | null;
  timestamp: string;
}

export interface StellarReceiptMetrics {
  /** Unique transactions the wallet took part in, either direction. */
  txCount: number;
  /** Latest observed transfer (ISO), null when none counted. */
  lastSeen: string | null;
  /** Distinct counterparties / NORMALIZE.diversityMax, capped at 1; null when none known. */
  diversity: number | null;
}

/**
 * Same-owner guard. `sameOwner` holds every address controlled by W's registry
 * owner (W included). Money moving between them is internal bookkeeping, not
 * customers, so it counts toward neither activity nor breadth. A payer shared by
 * two DIFFERENT owners is ordinary customer behavior and is kept.
 */
export function computeStellarReceiptMetrics(
  wallet: string,
  rows: readonly StellarReceiptRow[],
  sameOwner: ReadonlySet<string> = new Set([wallet]),
): StellarReceiptMetrics {
  const txs = new Set<string>();
  const counterparties = new Set<string>();
  let last = -Infinity;

  for (const r of rows) {
    let other: string | null;
    if (r.wallet_address === wallet) other = r.counterparty;
    else if (r.counterparty === wallet) other = r.wallet_address;
    else continue;
    if (other != null && (other === wallet || sameOwner.has(other))) continue;

    const t = Date.parse(r.timestamp);
    if (!Number.isFinite(t)) throw new Error('stellar_receipt_timestamp_invalid');
    txs.add(r.tx_signature);
    if (other != null) counterparties.add(other);
    if (t > last) last = t;
  }

  return {
    txCount: txs.size,
    lastSeen: txs.size > 0 ? new Date(last).toISOString() : null,
    diversity: counterparties.size > 0
      ? Math.min(counterparties.size / NORMALIZE.diversityMax, 1)
      : null,
  };
}

/** address → every address (owner + agent wallets) sharing its registry owner. */
export function buildStellarOwnerGroups(
  agents: ReadonlyArray<{ owner: string; agent_wallet: string | null }>,
): Map<string, Set<string>> {
  // Union-find over owner ↔ agent_wallet links, so control chains of any depth
  // (A owns agent X, X owns agent Y) collapse into one group. A one-level merge
  // would let Y→A transfers count as customers.
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let root = a;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let n = a; n !== root;) { const next = parent.get(n)!; parent.set(n, root); n = next; }
    return root;
  };
  const add = (a: string) => { if (!parent.has(a)) parent.set(a, a); };
  for (const a of agents) {
    add(a.owner);
    if (a.agent_wallet) {
      add(a.agent_wallet);
      const ra = find(a.owner), rb = find(a.agent_wallet);
      if (ra !== rb) parent.set(rb, ra);
    }
  }
  const byRoot = new Map<string, Set<string>>();
  for (const address of parent.keys()) {
    const r = find(address);
    const group = byRoot.get(r) ?? new Set<string>();
    group.add(address);
    byRoot.set(r, group);
  }
  const byAddress = new Map<string, Set<string>>();
  for (const address of parent.keys()) byAddress.set(address, byRoot.get(find(address))!);
  return byAddress;
}
