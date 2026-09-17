/// <reference types="bun-types" />
/**
 * Watchdog convergence: the webhook is desired state, not an object someone
 * else is assumed to have made.
 *
 * Run: bun test src/lib/helius-watchdog.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { checkOnce, WATCHED_ADDRESSES } from './helius-watchdog';

const URL_HINT = 'agentkarma.io/api/webhook/helius';
const HOOK_URL = `https://${URL_HINT}`;

interface Call { method: string; url: string; body?: Record<string, unknown> }

/** Fake Helius REST API. `listByKey` decides what each account can see. */
function heliusApi(options: {
  listByKey: Record<string, { status: number; hooks?: unknown[] }>;
  onWrite?: (call: Call) => { status: number };
}) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string | URL, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const key = new URL(url).searchParams.get('api-key') ?? '';
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, url, body });
    if (method === 'GET') {
      const reply = options.listByKey[key] ?? { status: 401 };
      return new Response(JSON.stringify(reply.hooks ?? []), { status: reply.status });
    }
    const { status } = options.onWrite?.({ method, url, body }) ?? { status: 200 };
    return new Response(JSON.stringify({ webhookID: 'new-hook' }), { status });
  };
  return { calls, fetchImpl };
}

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

function useEnv(env: Record<string, string>) {
  process.env = { ...originalEnv, ...env };
}

describe('webhook convergence', () => {
  // A credential that has never registered a webhook sees an empty list, so
  // re-enable-only logic would report "no webhook matched" indefinitely.
  test('an account with no webhook gets one created with the full watch set', async () => {
    useEnv({ HELIUS_API_KEY: 'fresh', HELIUS_WEBHOOK_SECRET: 's3cret', HELIUS_WEBHOOK_URL: HOOK_URL });
    const api = heliusApi({ listByKey: { fresh: { status: 200, hooks: [] } } });
    globalThis.fetch = api.fetchImpl as unknown as typeof fetch;

    const tick = await checkOnce(URL_HINT);

    const post = api.calls.find((c) => c.method === 'POST');
    expect(post).toBeDefined();
    expect(post!.body!.webhookURL).toBe(HOOK_URL);
    expect(post!.body!.accountAddresses).toEqual(WATCHED_ADDRESSES);
    expect(post!.body!.authHeader).toBe('Bearer s3cret');
    expect(tick!.created).toEqual(['new-hook']);
  });

  test('a healthy webhook is left completely alone', async () => {
    useEnv({ HELIUS_API_KEY: 'live', HELIUS_WEBHOOK_URL: HOOK_URL });
    const api = heliusApi({
      listByKey: { live: { status: 200, hooks: [{ webhookID: 'h1', webhookURL: HOOK_URL, active: true }] } },
    });
    globalThis.fetch = api.fetchImpl as unknown as typeof fetch;

    const tick = await checkOnce(URL_HINT);

    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(tick).toMatchObject({ matched: 1, active: 1, created: [], reEnabled: [] });
  });

  test('a disabled webhook is re-enabled, not duplicated', async () => {
    useEnv({ HELIUS_API_KEY: 'live', HELIUS_WEBHOOK_URL: HOOK_URL });
    const api = heliusApi({
      listByKey: {
        live: { status: 200, hooks: [{ webhookID: 'h1', webhookURL: HOOK_URL, active: false, disabledReason: '401s' }] },
      },
    });
    globalThis.fetch = api.fetchImpl as unknown as typeof fetch;

    const tick = await checkOnce(URL_HINT);

    expect(api.calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(api.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(tick!.reEnabled).toEqual([{ id: 'h1', reason: '401s' }]);
    expect(tick!.created).toEqual([]);
  });
});

describe('credential rotation', () => {
  test('a metered-out credential falls through and the next one is adopted', async () => {
    useEnv({ HELIUS_API_KEY: 'spent', HELIUS2_API_KEY: 'fresh', HELIUS_WEBHOOK_URL: HOOK_URL });
    const api = heliusApi({
      listByKey: { spent: { status: 429 }, fresh: { status: 200, hooks: [] } },
    });
    globalThis.fetch = api.fetchImpl as unknown as typeof fetch;

    const tick = await checkOnce(URL_HINT);

    expect(api.calls.map((c) => new URL(c.url).searchParams.get('api-key'))).toEqual(['spent', 'fresh', 'fresh']);
    expect(tick!.created).toEqual(['new-hook']);
  });

  test('a server error on the first key is not blamed on the credential', async () => {
    useEnv({ HELIUS_API_KEY: 'first', HELIUS2_API_KEY: 'second', HELIUS_WEBHOOK_URL: HOOK_URL });
    const api = heliusApi({ listByKey: { first: { status: 500 }, second: { status: 200, hooks: [] } } });
    globalThis.fetch = api.fetchImpl as unknown as typeof fetch;

    await expect(checkOnce(URL_HINT)).rejects.toThrow('500');
    expect(api.calls).toHaveLength(1);
  });
});
