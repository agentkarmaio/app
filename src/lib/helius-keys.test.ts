/// <reference types="bun-types" />
/**
 * Helius credential list + failover.
 *
 * Run: bun test src/lib/helius-keys.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { heliusApiKeys, heliusRpcUrls, isHeliusKeyExhausted, withHeliusKey } from './helius-keys';

const url = (key: string) => `https://mainnet.helius-rpc.com/?api-key=${key}`;

describe('credential list', () => {
  test('numbered vars are read in order and deduped', () => {
    const env = { HELIUS_RPC_URL: url('a'), HELIUS2_RPC_URL: url('b'), HELIUS3_RPC_URL: url('a') };
    expect(heliusRpcUrls(env)).toEqual([url('a'), url('b')]);
    expect(heliusApiKeys(env)).toEqual(['a', 'b']);
  });

  // An unset CI secret expands to the EMPTY STRING, which `??` accepts as
  // configured — a misconfiguration that reads as "set".
  test('an empty env var is unconfigured, not a configured blank', () => {
    expect(heliusRpcUrls({ HELIUS_RPC_URL: '', HELIUS2_RPC_URL: '   ' })).toEqual([]);
    expect(heliusApiKeys({ HELIUS_API_KEY: '', HELIUS2_API_KEY: '  ' })).toEqual([]);
    expect(heliusRpcUrls({ HELIUS2_RPC_URL: url('a') })).toEqual([url('a')]);
  });

  test('a gap in the numbering does not truncate the list', () => {
    expect(heliusApiKeys({ HELIUS_API_KEY: 'a', HELIUS4_API_KEY: 'd' })).toEqual(['a', 'd']);
  });

  test('a named key outranks one parsed out of a URL', () => {
    expect(heliusApiKeys({ HELIUS_RPC_URL: url('a'), HELIUS2_API_KEY: 'b' })).toEqual(['b', 'a']);
  });

  test('a URL without an api-key contributes no key but stays a usable RPC url', () => {
    const env = { HELIUS_RPC_URL: 'https://mainnet.helius-rpc.com/', HELIUS2_RPC_URL: url('a') };
    expect(heliusRpcUrls(env)).toHaveLength(2);
    expect(heliusApiKeys(env)).toEqual(['a']);
  });
});

describe('exhaustion signals', () => {
  test.each([401, 402, 403, 429])('%i means try the next key', (status) => {
    expect(isHeliusKeyExhausted(status)).toBe(true);
  });
  test.each([200, 400, 404, 500, 503])('%i is not a credential problem', (status) => {
    expect(isHeliusKeyExhausted(status)).toBe(false);
  });
});

describe('withHeliusKey', () => {
  const env = { HELIUS_API_KEY: 'first', HELIUS2_API_KEY: 'second' };

  test('a working first key is the only one used', async () => {
    const seen: string[] = [];
    const out = await withHeliusKey(async (key) => { seen.push(key); return `ok:${key}`; }, env);
    expect(out).toBe('ok:first');
    expect(seen).toEqual(['first']);
  });

  test('an exhausted credential falls through to the next', async () => {
    const seen: string[] = [];
    const out = await withHeliusKey(async (key) => {
      seen.push(key);
      if (key === 'first') throw Object.assign(new Error('Helius listWebhooks 429'), { status: 429 });
      return `ok:${key}`;
    }, env);
    expect(out).toBe('ok:second');
    expect(seen).toEqual(['first', 'second']);
  });

  // Burning every credential on a bug in our own payload turns one broken call
  // into N, and hides which key was actually at fault.
  test('a non-credential failure propagates without touching the next key', async () => {
    const seen: string[] = [];
    await expect(withHeliusKey(async (key) => {
      seen.push(key);
      throw Object.assign(new Error('Helius PUT webhook → 500'), { status: 500 });
    }, env)).rejects.toThrow('500');
    expect(seen).toEqual(['first']);
  });

  test('every key exhausted throws the last error rather than returning nothing', async () => {
    await expect(withHeliusKey(async () => {
      throw Object.assign(new Error('429 max usage reached'), { status: 429 });
    }, env)).rejects.toThrow('max usage reached');
  });

  test('no credentials configured is an explicit error, not a silent skip', async () => {
    await expect(withHeliusKey(async () => 'unreachable', {})).rejects.toThrow(/no Helius/i);
  });
});
