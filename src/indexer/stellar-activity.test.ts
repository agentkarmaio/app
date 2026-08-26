/// <reference types="bun-types" />
/**
 * Horizon activity reader — pure + injected-fetch tests. No network.
 *
 * Covers counterparty extraction per operation type, the transactions/payments
 * merge, pagination stop conditions, and the address guard that keeps an
 * unvalidated string out of the Horizon URL.
 *
 * Run: bun test src/indexer/stellar-activity.test.ts
 */

import { describe, expect, test } from 'bun:test';
import {
  extractCounterparty,
  fetchStellarActivity,
  isHorizonNotFound,
  type HorizonFetch,
} from './stellar-activity';

const SELF = 'GA6OBKNSBCY2I4PQLGNNQQXRXWXRUBRLSKLM7YP7QBBSRW7LCZFLHODV';
const OTHER = 'GCIKP52ZNC4SEPLHKXIA6KBBIBTVRLNDIOTDBHQ3VEPSU4SY7JMCYSDK';

describe('extractCounterparty', () => {
  test('payment sent → the recipient', () => {
    expect(extractCounterparty({ type: 'payment', from: SELF, to: OTHER }, SELF)).toBe(OTHER);
  });

  test('payment received → the sender', () => {
    expect(extractCounterparty({ type: 'payment', from: OTHER, to: SELF }, SELF)).toBe(OTHER);
  });

  test('path_payment_strict_receive behaves like payment', () => {
    expect(
      extractCounterparty({ type: 'path_payment_strict_receive', from: OTHER, to: SELF }, SELF),
    ).toBe(OTHER);
  });

  test('create_account → the funder when we are the created account', () => {
    expect(extractCounterparty({ type: 'create_account', funder: OTHER, account: SELF }, SELF)).toBe(OTHER);
  });

  test('create_account → the created account when we are the funder', () => {
    expect(extractCounterparty({ type: 'create_account', funder: SELF, account: OTHER }, SELF)).toBe(OTHER);
  });

  test('account_merge → the destination', () => {
    expect(extractCounterparty({ type: 'account_merge', account: SELF, into: OTHER }, SELF)).toBe(OTHER);
  });

  test('unknown op type → no counterparty', () => {
    expect(extractCounterparty({ type: 'manage_data' }, SELF)).toBeNull();
  });

  test('self-referential payment → no counterparty', () => {
    expect(extractCounterparty({ type: 'payment', from: SELF, to: SELF }, SELF)).toBeNull();
  });
});

// ─── fetchStellarActivity ────────────────────────────────────────────────────

function page(records: unknown[], next?: string) {
  return {
    _links: next ? { next: { href: next } } : {},
    _embedded: { records },
  };
}

/** Route by path so one fake serves both the transactions and payments reads. */
function fakeFetch(routes: Record<string, unknown>, calls: string[] = []): HorizonFetch {
  return async (url: string) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected horizon url: ${url}`);
    return routes[key] as Record<string, unknown>;
  };
}

describe('fetchStellarActivity', () => {
  test('builds the timeline from transactions and enriches counterparties from payments', async () => {
    const fetchFn = fakeFetch({
      '/transactions': page([
        { hash: 'h1', created_at: '2026-08-01T10:00:00Z', successful: true },
        { hash: 'h2', created_at: '2026-08-01T11:00:00Z', successful: true },
        { hash: 'h3', created_at: '2026-08-01T12:00:00Z', successful: true },
      ]),
      '/payments': page([
        { type: 'payment', transaction_hash: 'h1', from: SELF, to: OTHER, created_at: '2026-08-01T10:00:00Z' },
        { type: 'manage_data', transaction_hash: 'h2', created_at: '2026-08-01T11:00:00Z' },
      ]),
    });

    const acts = await fetchStellarActivity(SELF, { fetchFn });

    expect(acts).toHaveLength(3);
    expect(acts.map((a) => a.timestamp)).toEqual([
      '2026-08-01T10:00:00Z',
      '2026-08-01T11:00:00Z',
      '2026-08-01T12:00:00Z',
    ]);
    // Only h1 had an extractable counterparty; the rest are null, which
    // computeAutonomy handles by redistributing the breadth weight.
    expect(acts[0].counterparty).toBe(OTHER);
    expect(acts[1].counterparty).toBeNull();
    expect(acts[2].counterparty).toBeNull();
  });

  test('follows pagination up to maxPages and then stops', async () => {
    const calls: string[] = [];
    let txPage = 0;
    const fetchFn: HorizonFetch = async (url) => {
      calls.push(url);
      if (url.includes('/payments')) return page([]);
      txPage++;
      return page(
        [{ hash: `h${txPage}`, created_at: `2026-08-0${txPage}T10:00:00Z`, successful: true }],
        `https://horizon.stellar.org/next?cursor=${txPage}`,
      );
    };

    const acts = await fetchStellarActivity(SELF, { fetchFn, maxPages: 3 });

    expect(acts).toHaveLength(3);
    expect(calls.filter((c) => !c.includes('/payments'))).toHaveLength(3);
  });

  // A capped read is a PARTIAL view of history. Callers must be able to say so
  // rather than reporting the truncated count as the account's full activity.
  test('signals onPageCap when the budget runs out with more pages available', async () => {
    let capped = false;
    const fetchFn: HorizonFetch = async (url) => {
      if (url.includes('/payments')) return page([]);
      return page(
        [{ hash: 'h', created_at: '2026-08-01T10:00:00Z', successful: true }],
        'https://horizon.stellar.org/next',
      );
    };

    await fetchStellarActivity(SELF, { fetchFn, maxPages: 2, onPageCap: () => { capped = true; } });
    expect(capped).toBe(true);
  });

  test('does not signal onPageCap when the collection simply ends', async () => {
    let capped = false;
    const fetchFn = fakeFetch({
      '/transactions': page([{ hash: 'h', created_at: '2026-08-01T10:00:00Z', successful: true }]),
      '/payments': page([]),
    });

    await fetchStellarActivity(SELF, { fetchFn, maxPages: 5, onPageCap: () => { capped = true; } });
    expect(capped).toBe(false);
  });

  test('stops early when a page returns no records', async () => {
    const calls: string[] = [];
    let txPage = 0;
    const fetchFn: HorizonFetch = async (url) => {
      calls.push(url);
      if (url.includes('/payments')) return page([]);
      txPage++;
      if (txPage > 1) return page([], 'https://horizon.stellar.org/next');
      return page(
        [{ hash: 'h1', created_at: '2026-08-01T10:00:00Z', successful: true }],
        'https://horizon.stellar.org/next',
      );
    };

    const acts = await fetchStellarActivity(SELF, { fetchFn, maxPages: 10 });

    expect(acts).toHaveLength(1);
    expect(calls.filter((c) => !c.includes('/payments'))).toHaveLength(2);
  });

  // Regression (2026-08-05, caught by the first scheduled run): GitHub Actions
  // substitutes an UNSET secret as an EMPTY STRING, so STELLAR_HORIZON_URL=''
  // reached the resolver. `??` only falls back on null/undefined, so the base
  // became '' and every fetch failed with "fetch() URL is invalid" — 12/12
  // addresses errored while the job still reported success.
  test('treats an empty STELLAR_HORIZON_URL env as unset', async () => {
    const prev = process.env.STELLAR_HORIZON_URL;
    process.env.STELLAR_HORIZON_URL = '';
    try {
      const calls: string[] = [];
      const fetchFn = fakeFetch({ 'horizon.stellar.org': page([]) }, calls);
      await fetchStellarActivity(SELF, { fetchFn });
      expect(calls[0]).toStartWith('https://horizon.stellar.org/accounts/');
    } finally {
      if (prev === undefined) delete process.env.STELLAR_HORIZON_URL;
      else process.env.STELLAR_HORIZON_URL = prev;
    }
  });

  test('treats a whitespace-only horizonUrl option as unset', async () => {
    const calls: string[] = [];
    const fetchFn = fakeFetch({ 'horizon.stellar.org': page([]) }, calls);
    await fetchStellarActivity(SELF, { fetchFn, horizonUrl: '   ' });
    expect(calls[0]).toStartWith('https://horizon.stellar.org/accounts/');
  });

  test('rejects a non-StrKey address instead of interpolating it into the URL', async () => {
    const calls: string[] = [];
    const fetchFn = fakeFetch({ '/': page([]) }, calls);
    await expect(fetchStellarActivity('0xdeadbeef', { fetchFn })).rejects.toThrow(/StrKey/);
    expect(calls).toHaveLength(0);
  });

  test('a failing payments read degrades to a counterparty-free timeline', async () => {
    const fetchFn: HorizonFetch = async (url) => {
      if (url.includes('/payments')) throw new Error('Horizon 503');
      return page([{ hash: 'h1', created_at: '2026-08-01T10:00:00Z', successful: true }]);
    };

    const acts = await fetchStellarActivity(SELF, { fetchFn });

    expect(acts).toHaveLength(1);
    expect(acts[0].counterparty).toBeNull();
  });
});

describe('isHorizonNotFound', () => {
  async function catchErr(status: number, statusText: string): Promise<unknown> {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('{}', { status, statusText })) as unknown as typeof fetch;
    try {
      return await fetchStellarActivity(SELF).catch((e: unknown) => e);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  test('tags a Horizon 404 as an absent account, not a generic failure', async () => {
    expect(isHorizonNotFound(await catchErr(404, 'Not Found'))).toBe(true);
  });

  test('does not tag a 503 as absent — a real Horizon failure must still page', async () => {
    expect(isHorizonNotFound(await catchErr(503, 'Service Unavailable'))).toBe(false);
  });

  test('does not tag an untagged error as absent', () => {
    expect(isHorizonNotFound(new Error('Horizon 404 Not Found for https://x/'))).toBe(false);
    expect(isHorizonNotFound('nope')).toBe(false);
  });
});
