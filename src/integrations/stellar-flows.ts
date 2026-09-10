/**
 * Stellar payment flows, read from Horizon at request time.
 *
 * `transactions` holds no Stellar rows: the receipt indexer only matches
 * payments settled through an OZ Channels facilitator, and real Soroban agents
 * pay their own fees, so there is no facilitator to match. Rather than model a
 * testnet chain key or index the whole chain, we read the one account being
 * asked about, straight from Horizon, and hand the flows to the same pure
 * `computeReciprocity` the database path uses.
 *
 * Nothing here writes. These flows are evidence for the independence block
 * only — they never enter `transactions`, never feed karma, Explore or
 * rank_score. Tier-1 receipt ingestion stays the indexer's job.
 *
 * Spec: (design notes, kept out of this repo)
 */

import { USDC_ISSUER, type StellarNetwork } from '@/config/stellar-x402';
import type { ReciprocityInput } from '@/scoring/reciprocity';

/** Re-exported for convenience; the single definition lives in the chain config. */
export { USDC_ISSUER };

const HORIZON_URL: Record<StellarNetwork, string> = {
  pubnet: 'https://horizon.stellar.org',
  testnet: 'https://horizon-testnet.stellar.org',
};

/** Horizon's own maximum page size. */
export const STELLAR_FLOW_PAGE_LIMIT = 200;

/** At most 1000 records per read. Bounded by construction, like every other enrichment read. */
export const STELLAR_FLOW_MAX_PAGES = 5;

/** Injected transport, so nothing in this module needs the network to be tested. */
export type HorizonJsonFetch = (url: string) => Promise<Record<string, unknown>>;

export interface StellarFlows {
  outbound: Array<{ counterparty: string | null; amount: number }>;
  inbound: Array<{ payer: string; total: number; count: number }>;
}

export interface StellarFlowsResult {
  /** Ready to hand to `computeReciprocity`. */
  flows: ReciprocityInput;
  /** Which network the account was found on. Must reach the caller — a testnet
   *  reading presented as mainnet is precisely the error this signal exists to catch. */
  network: StellarNetwork;
  /** True when a page came back full: the figures are a recent sample, not all history. */
  saturated: boolean;
}

/** Per-request bound. This sits on a page read, so a slow Horizon must drop the
 *  block rather than hold the whole karma response open. */
export const HORIZON_TIMEOUT_MS = 4_000;

const defaultFetch: HorizonJsonFetch = async (url) => {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(HORIZON_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`horizon ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Finite and positive, or it does not contribute. */
function usableAmount(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** One side-of-payment entry, normalized across the classic and Soroban shapes. */
interface Movement {
  from: unknown;
  to: unknown;
  amount: unknown;
  code: unknown;
  issuer: unknown;
}

/**
 * Horizon renders the two payment shapes differently:
 *   - a classic `payment` op carries from/to/amount/asset_* on the record itself
 *   - a Soroban SAC transfer is an `invoke_host_function` op whose
 *     `asset_balance_changes` entries each carry their own from/to/asset_*
 * Both reduce to the same movement.
 */
function movementsOf(record: unknown): Movement[] {
  if (!isRecord(record)) return [];
  const out: Movement[] = [];

  const changes = record.asset_balance_changes;
  if (Array.isArray(changes)) {
    for (const c of changes) {
      if (!isRecord(c)) continue;
      out.push({ from: c.from, to: c.to, amount: c.amount, code: c.asset_code, issuer: c.asset_issuer });
    }
  }

  if (record.type === 'payment') {
    out.push({
      from: record.from,
      to: record.to,
      amount: record.amount,
      code: record.asset_code,
      issuer: record.asset_issuer,
    });
  }

  return out;
}

/**
 * Fold Horizon payment records into reciprocity flows for one account.
 *
 * Pure. Anything unrecognized — a malformed record, another asset, the wrong
 * issuer, a transfer between two third parties — is skipped rather than guessed
 * at. Stellar StrKey is case-sensitive, so addresses are compared verbatim.
 */
export function foldHorizonPayments(
  records: readonly unknown[],
  account: string,
  network: StellarNetwork,
): StellarFlows {
  const issuer = USDC_ISSUER[network];
  const outbound: StellarFlows['outbound'] = [];
  const byPayer = new Map<string, { payer: string; total: number; count: number }>();

  for (const record of records) {
    for (const m of movementsOf(record)) {
      if (m.code !== 'USDC' || m.issuer !== issuer) continue;
      const amount = usableAmount(m.amount);
      if (amount === 0) continue;

      if (m.to === account && typeof m.from === 'string') {
        const entry = byPayer.get(m.from) ?? { payer: m.from, total: 0, count: 0 };
        entry.total += amount;
        entry.count += 1;
        byPayer.set(m.from, entry);
      } else if (m.from === account && typeof m.to === 'string') {
        outbound.push({ counterparty: m.to, amount });
      }
    }
  }

  return { outbound, inbound: [...byPayer.values()] };
}

/** Does this account exist on this network? A failed lookup means "no". */
export async function accountExists(
  account: string,
  network: StellarNetwork,
  fetchJson: HorizonJsonFetch,
): Promise<boolean> {
  try {
    const body = await fetchJson(`${HORIZON_URL[network]}/accounts/${account}`);
    return isRecord(body) && typeof body.id === 'string';
  } catch {
    return false;
  }
}

/** Page a payments feed, newest first, stopping at the cap. */
async function readPayments(
  account: string,
  network: StellarNetwork,
  fetchJson: HorizonJsonFetch,
  maxPages: number,
): Promise<{ records: unknown[]; saturated: boolean }> {
  const records: unknown[] = [];
  let url = `${HORIZON_URL[network]}/accounts/${account}/payments?limit=${STELLAR_FLOW_PAGE_LIMIT}&order=desc&join=transactions`;

  for (let page = 0; page < maxPages; page++) {
    const body = await fetchJson(url);
    const embedded = isRecord(body) ? body._embedded : null;
    const batch = isRecord(embedded) && Array.isArray(embedded.records) ? embedded.records : [];
    records.push(...batch);

    // A short page means we reached the end of this account's history.
    if (batch.length < STELLAR_FLOW_PAGE_LIMIT) return { records, saturated: false };

    // Full page AND no budget left to look further: we are stopping because of
    // our own cap, so the caller holds a recent sample, not the whole history.
    // A full FIRST page is not itself saturation — the next page may finish it.
    if (page === maxPages - 1) return { records, saturated: true };

    const links = isRecord(body) ? body._links : null;
    const next = isRecord(links) && isRecord(links.next) ? links.next.href : null;
    if (typeof next !== 'string') return { records, saturated: false };
    url = next;
  }

  return { records, saturated: false };
}

/**
 * Resolve an account's USDC flows from Horizon.
 *
 * Mainnet is tried first; testnet is consulted only when the account does not
 * exist on mainnet, and the answer says which one it used. Returns null when
 * the account exists on neither network, or when Horizon cannot be read —
 * callers treat that as an absent block, never as an error, matching how every
 * other enrichment block degrades.
 */
export async function fetchStellarFlows(
  account: string,
  opts: { fetchJson?: HorizonJsonFetch; maxPages?: number } = {},
): Promise<StellarFlowsResult | null> {
  const fetchJson = opts.fetchJson ?? defaultFetch;
  const maxPages = opts.maxPages ?? STELLAR_FLOW_MAX_PAGES;

  let network: StellarNetwork | null = null;
  for (const candidate of ['pubnet', 'testnet'] as const) {
    if (await accountExists(account, candidate, fetchJson)) {
      network = candidate;
      break;
    }
  }
  if (network === null) return null;

  try {
    const { records, saturated } = await readPayments(account, network, fetchJson, maxPages);
    const { outbound, inbound } = foldHorizonPayments(records, account, network);
    return { flows: { chain: 'stellar', outbound, inbound }, network, saturated };
  } catch {
    return null;
  }
}

/**
 * One cheap probe: does this account exist on either network?
 *
 * Used by the score route to decide whether an address it has never indexed is
 * nonetheless a real Stellar account worth answering about. Deliberately
 * separate from {@link fetchStellarFlows} so the 404 gate costs at most two
 * small requests rather than a full paged read.
 */
export async function stellarAccountExists(
  account: string,
  opts: { fetchJson?: HorizonJsonFetch } = {},
): Promise<boolean> {
  const fetchJson = opts.fetchJson ?? defaultFetch;
  for (const network of ['pubnet', 'testnet'] as const) {
    if (await accountExists(account, network, fetchJson)) return true;
  }
  return false;
}
