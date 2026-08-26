/**
 * Horizon activity reader — the behavioral (Tier 2) data source for Stellar.
 *
 * WHY this exists: `computeCadence` / `computeAutonomy` read the `transactions`
 * table, which only the Solana x402 indexer fills. Stellar's x402 indexer is
 * dormant (no facilitators seeded), so every Stellar agent shows a NULL
 * autonomy score and cadence despite visibly transacting on-chain — measured
 * 2026-08-05, the four longest-registered Stellar agents have 23 / 24 / 65 / 4
 * transactions in Horizon.
 *
 * WHAT IT MUST NOT DO: write `transactions` rows. That table is the x402
 * *receipt* ledger, and `metric_volume` / `metric_success_rate` /
 * `consumer_score` are derived from it. Generic account activity is not a paid
 * receipt — persisting it there would fabricate a payment reputation out of
 * arbitrary transfers. This module returns activity for behavioral computation
 * only; volume and success-rate stay NULL until real receipts land.
 *
 * Timeline source is `/accounts/{a}/transactions` (complete — includes Soroban
 * `invoke_host_function`, which is what an 8004 agent actually does), enriched
 * with counterparties from `/accounts/{a}/payments` (transactions carry no
 * counterparty). `computeAutonomy` accepts a null counterparty and redistributes
 * the `counterparty_breadth` weight, so a partial map degrades correctly rather
 * than scoring falsely.
 */

// Pure + dependency-free, same as this module.
import { optionalEnv } from '@/lib/require-env';

// Stellar StrKey: G… Ed25519 public accounts are 56 chars, base32 (A–Z, 2–7).
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

const DEFAULT_HORIZON = 'https://horizon.stellar.org';
const PAGE_LIMIT = 200;
const DEFAULT_MAX_PAGES = 5;

/**
 * Resolve the Horizon base URL, treating a blank override as absent.
 *
 * `??` is WRONG here: GitHub Actions substitutes an unset secret as an EMPTY
 * STRING, so `STELLAR_HORIZON_URL: ${{ secrets.STELLAR_HORIZON_URL }}` arrives
 * as `''` — which `??` happily accepts, producing paths like
 * `/accounts/G…/transactions` and "fetch() URL is invalid". That is exactly how
 * the first scheduled run (2026-08-05) reported success while writing nothing
 * for 12/12 addresses. `resolveStellarRpcUrl` already uses `||` for the same
 * reason, which is why the registry step in that run was unaffected.
 */
export function resolveHorizonUrl(
  override?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return override?.trim() || optionalEnv('STELLAR_HORIZON_URL', DEFAULT_HORIZON, env);
}

/** Injected transport so the reader is testable without network. */
export type HorizonFetch = (url: string) => Promise<Record<string, unknown>>;

/** One observed on-chain action, in the shape the behavioral scorers consume. */
export interface StellarActivity {
  timestamp: string;
  counterparty: string | null;
}

/** The operation fields Horizon exposes that can carry a counterparty. */
export interface HorizonOperation {
  type: string;
  from?: string;
  to?: string;
  funder?: string;
  account?: string;
  into?: string;
  transaction_hash?: string;
  created_at?: string;
}

/**
 * Resolve the other party in an operation, from `self`'s perspective. Returns
 * null for operations with no counterparty (manage_data, set_options, Soroban
 * invocations) and for self-referential transfers, which would otherwise
 * inflate `counterparty_breadth` with the agent's own address.
 */
export function extractCounterparty(op: HorizonOperation, self: string): string | null {
  let other: string | undefined;
  switch (op.type) {
    case 'payment':
    case 'path_payment_strict_receive':
    case 'path_payment_strict_send':
      other = op.from === self ? op.to : op.from;
      break;
    case 'create_account':
      other = op.funder === self ? op.account : op.funder;
      break;
    case 'account_merge':
      other = op.account === self ? op.into : op.account;
      break;
    default:
      return null;
  }
  if (!other || other === self) return null;
  return other;
}

export interface FetchActivityOpts {
  fetchFn?: HorizonFetch;
  horizonUrl?: string;
  /** Pages of 200 to walk per endpoint. Default 5 → up to 1000 records. */
  maxPages?: number;
  timeoutMs?: number;
  /**
   * Called when the timeline walk stopped at `maxPages` while Horizon still had
   * more pages. The caller MUST surface this — a capped read is a partial view
   * of the account's history, and reporting it as a complete count would
   * misstate how much evidence the behavioral score rests on.
   */
  onPageCap?: () => void;
}

/**
 * A Horizon failure carrying its HTTP status, so callers can tell "this account
 * does not exist on this network" (404 — a permanent, expected state for a
 * registry entry that was never funded on mainnet) apart from a genuine
 * outage. Callers MUST branch on the status, never on the message text.
 */
export interface HorizonHttpError extends Error {
  status: number;
}

/** True only for a status-tagged Horizon 404 — the account is absent. */
export function isHorizonNotFound(err: unknown): err is HorizonHttpError {
  return err instanceof Error && (err as Partial<HorizonHttpError>).status === 404;
}

async function defaultFetch(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Horizon ${res.status} ${res.statusText} for ${url}`), {
      status: res.status,
    });
  }
  return (await res.json()) as Record<string, unknown>;
}

interface HorizonPage {
  _links?: { next?: { href?: string } };
  _embedded?: { records?: unknown[] };
}

/**
 * Walk a Horizon collection, following `_links.next` until it runs out, a page
 * comes back empty, or `maxPages` is reached. Bounded by construction — there
 * is no unbounded-walk path.
 */
async function walk(
  firstUrl: string,
  fetchFn: HorizonFetch,
  maxPages: number,
): Promise<{ records: unknown[]; capped: boolean }> {
  const out: unknown[] = [];
  let url: string | undefined = firstUrl;
  let pageNo = 0;
  for (; pageNo < maxPages && url; pageNo++) {
    const body = (await fetchFn(url)) as HorizonPage;
    const records = body._embedded?.records ?? [];
    if (records.length === 0) break;
    out.push(...records);
    url = body._links?.next?.href;
  }
  // Capped only when the budget ran out with a further page still on offer —
  // stopping because the collection ended is not truncation.
  return { records: out, capped: pageNo >= maxPages && url != null };
}

/**
 * Read an account's recent on-chain activity, oldest-first (the order the
 * behavioral scorers sort into anyway).
 *
 * The payments read is best-effort: if it fails, the timeline is still returned
 * with null counterparties rather than losing the whole address's behavior.
 */
export async function fetchStellarActivity(
  address: string,
  opts: FetchActivityOpts = {},
): Promise<StellarActivity[]> {
  // Guard before interpolation — never put an unvalidated string into the URL.
  if (!STELLAR_ADDRESS_RE.test(address)) {
    throw new Error(`not a Stellar StrKey account address: ${address.slice(0, 12)}…`);
  }

  const timeoutMs = opts.timeoutMs ?? 10_000;
  const fetchFn = opts.fetchFn ?? ((url: string) => defaultFetch(url, timeoutMs));
  const base = resolveHorizonUrl(opts.horizonUrl);
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const q = `limit=${PAGE_LIMIT}&order=desc`;

  const timeline = await walk(`${base}/accounts/${address}/transactions?${q}`, fetchFn, maxPages);
  if (timeline.capped) opts.onPageCap?.();
  const txRecords = timeline.records as Array<{ hash?: string; created_at?: string }>;

  let counterpartyByTx = new Map<string, string>();
  try {
    const payments = (await walk(`${base}/accounts/${address}/payments?${q}`, fetchFn, maxPages))
      .records as HorizonOperation[];
    counterpartyByTx = new Map(
      payments
        .map((op) => [op.transaction_hash, extractCounterparty(op, address)] as const)
        .filter((e): e is readonly [string, string] => e[0] != null && e[1] != null),
    );
  } catch {
    // Counterparty enrichment is optional — the timeline alone still yields
    // cadence and every autonomy component except counterparty_breadth.
  }

  return txRecords
    .filter((r) => typeof r.created_at === 'string')
    .map((r) => ({
      timestamp: r.created_at as string,
      counterparty: (r.hash && counterpartyByTx.get(r.hash)) ?? null,
    }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
