import { getCursor, supabase, upsertCursor } from '@/db/client';
import { getIndexingHeaders } from '@/db/indexing-context';

// explorer.arc.io is a Blockscout v2 instance. Its `filter` query enum only
// supports from|to — there is no failed filter — so outgoing direction and
// settlement are both derived from the item payload itself: an item whose
// `from` is the wallet is an outgoing transaction, and any `status` other
// than 'ok' is a failed one. This is the only evidence source for failed
// transactions on arc-mainnet: a reverted transaction emits no logs, so the
// transfer stream that feeds the score never sees them.
const CURSOR_KEY = 'arc-mainnet-failed-tx';
const ADDRESS = /^0x[0-9a-f]{40}$/;
const EXPLORER_BASE = 'https://explorer.arc.io/api/v2/addresses';

export interface ExplorerItem {
  hash: string;
  from?: { hash?: string };
  status?: string;
}

export interface ExplorerPage {
  items?: ExplorerItem[];
  next_page_params?: Record<string, unknown> | null;
}

export interface ArcMainnetFailedTxOptions {
  signal?: AbortSignal;
  fetchJson?: (url: string, signal?: AbortSignal) => Promise<ExplorerPage>;
  maxWallets?: number;
  timeBudgetMs?: number;
  maxPagesPerWallet?: number;
  pageDelayMs?: number;
  maxPageRetries?: number;
}

export interface ArcMainnetFailedTxResult {
  swept: number;
  complete: boolean;
  cursor: string;
  challenged: boolean;
}

export function isExplorerChallenge(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'explorer_challenged';
}

function challengeError(): Error {
  const error = new Error('explorer_challenged') as Error & { code: string };
  error.code = 'explorer_challenged';
  return error;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise(resolve => { setTimeout(resolve, ms); }) : Promise.resolve();
}

/** Production transport for the explorer API. The host sits behind a
 * Cloudflare managed challenge; 403/429 statuses and HTML interstitials all
 * surface as challenge errors so the sweep's bounded retry and stop-with-flag
 * apply uniformly. */
export async function fetchExplorerJson(url: string, signal?: AbortSignal): Promise<ExplorerPage> {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    },
    signal,
  });
  if (response.status === 403 || response.status === 429) throw challengeError();
  const body = await response.text();
  if (!response.ok) throw new Error(`explorer_http_${response.status}`);
  const trimmed = body.trimStart();
  if (trimmed.startsWith('<')) throw challengeError();
  return JSON.parse(trimmed) as ExplorerPage;
}

function pageQuery(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) search.set(key, String(value));
  }
  return search.toString();
}

/** Sweep real outgoing settlement rates for arc-mainnet wallets from the
 * explorer ledger and persist `metric_success_rate`. The denominator is all
 * outgoing transactions (approvals and contract calls included): a failed tx
 * cannot be classified as a payment attempt because it emits no logs. A
 * wallet the explorer shows no outgoing activity for is skipped — a zero can
 * mean absence or a blind spot, never a 1.0. Writes are targeted updates on
 * `metric_success_rate` only; the score refresh owns every other wallet
 * column. A challenged explorer stops the sweep for this run with the cursor
 * held at the last fully counted wallet, so progress is resumable. */
export async function sweepArcMainnetFailedTxs(
  options: ArcMainnetFailedTxOptions = {},
): Promise<ArcMainnetFailedTxResult> {
  const {
    signal, fetchJson = fetchExplorerJson,
    maxWallets = 25, timeBudgetMs = 30_000, maxPagesPerWallet = 20,
    pageDelayMs = 250, maxPageRetries = 2,
  } = options;
  if (!Number.isSafeInteger(maxWallets) || maxWallets < 1 || maxWallets > 10_000
    || !Number.isFinite(timeBudgetMs) || timeBudgetMs <= 0 || timeBudgetMs > 40_000
    || !Number.isSafeInteger(maxPagesPerWallet) || maxPagesPerWallet < 1 || maxPagesPerWallet > 200
    || !Number.isSafeInteger(pageDelayMs) || pageDelayMs < 0 || pageDelayMs > 10_000
    || !Number.isSafeInteger(maxPageRetries) || maxPageRetries < 0 || maxPageRetries > 10) {
    throw new Error('arc_mainnet_failed_tx_sweep_invalid');
  }
  function assertLease() {
    signal?.throwIfAborted();
    const context = getIndexingHeaders();
    if (context['x-indexing-chain'] !== 'arc-mainnet'
      || context['x-indexing-path'] !== 'transfers' || !context['x-indexing-owner']) {
      throw new Error('arc_mainnet_lease_required');
    }
  }
  assertLease();
  const started = performance.now();
  let cursor = (await getCursor(CURSOR_KEY, 'arc-mainnet'))?.last_signature ?? '';
  if (cursor !== '' && !ADDRESS.test(cursor)) throw new Error('arc_mainnet_failed_tx_cursor_invalid');

  let query = supabase.from('wallets').select('address')
    .eq('chain', 'arc-mainnet').order('address', { ascending: true }).limit(maxWallets);
  if (cursor) query = query.gt('address', cursor);
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as Array<{ address: string }>;
  if (rows.length === 0) {
    // The rotation ran past the last wallet: wrap the cursor so the next
    // cycle re-sweeps from the beginning. An empty chain has nothing to wrap.
    if (cursor) {
      assertLease();
      await upsertCursor(CURSOR_KEY, '', undefined, 'arc-mainnet');
    }
    return { swept: 0, complete: true, cursor: '', challenged: false };
  }
  // Reject malformed or non-increasing keys before touching any wallet.
  let previous = cursor;
  for (const row of rows) {
    if (!ADDRESS.test(row.address) || row.address <= previous) throw new Error('arc_mainnet_failed_tx_cursor_invalid');
    previous = row.address;
  }

  let swept = 0;
  let fetched = 0;
  for (const { address } of rows) {
    if (performance.now() - started >= timeBudgetMs) {
      return { swept, complete: false, cursor, challenged: false };
    }
    assertLease();
    let outgoing = 0;
    let failedOutgoing = 0;
    let nextPage: Record<string, unknown> | null = null;
    let fullyCounted = false;
    for (let pageIndex = 0; pageIndex < maxPagesPerWallet; pageIndex++) {
      const path = `${EXPLORER_BASE}/${address.toLowerCase()}/transactions`;
      let page: ExplorerPage | null = null;
      for (let attempt = 0; attempt <= maxPageRetries; attempt++) {
        try {
          if (fetched > 0 || attempt > 0) {
            assertLease();
            await sleep(pageDelayMs);
            assertLease();
          }
          page = await fetchJson(nextPage ? `${path}?${pageQuery(nextPage)}` : path, signal);
          fetched++;
          break;
        } catch (err) {
          if (!isExplorerChallenge(err)) throw err;
        }
      }
      if (page === null) return { swept, complete: false, cursor, challenged: true };
      for (const item of page.items ?? []) {
        const from = item.from?.hash;
        if (typeof from === 'string' && from.toLowerCase() === address.toLowerCase()) {
          outgoing++;
          if (item.status !== 'ok') failedOutgoing++;
        }
      }
      if (page.next_page_params == null) { fullyCounted = true; break; }
      nextPage = page.next_page_params;
    }
    if (!fullyCounted) {
      // Page budget exhausted mid-wallet: the counts are incomplete, so the
      // cursor must not advance past this wallet. Resume next run.
      return { swept, complete: false, cursor, challenged: false };
    }
    if (outgoing > 0) {
      assertLease();
      const { error: updateError } = await supabase.from('wallets')
        .update({ metric_success_rate: (outgoing - failedOutgoing) / outgoing })
        .eq('chain', 'arc-mainnet').eq('address', address);
      if (updateError) throw updateError;
    }
    cursor = address;
    await upsertCursor(CURSOR_KEY, cursor, undefined, 'arc-mainnet');
    swept++;
  }
  return { swept, complete: true, cursor: '', challenged: false };
}