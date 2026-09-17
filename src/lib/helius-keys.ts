/**
 * Helius credentials, as an ordered list rather than a single string.
 *
 * Providers meter by account, so a single hardcoded credential makes every
 * Helius-backed path — including the webhook watchdog — only as available as
 * one quota. This module is the single place that answers "which credential do
 * we use", so additional ones are configuration rather than a code change.
 *
 * Config, in preference order:
 *   HELIUS_RPC_URL,  HELIUS2_RPC_URL,  HELIUS3_RPC_URL …   full RPC URLs (each may carry ?api-key=)
 *   HELIUS_API_KEY,  HELIUS2_API_KEY,  HELIUS3_API_KEY …   bare keys
 *
 * Note `SOLANA_RPC_URL` is NOT here on purpose: indexer reads prefer it
 * precisely so ingestion does not depend on a Helius quota at all.
 */

type Env = Record<string, string | undefined>;

/** `HELIUS_X`, `HELIUS2_X`, `HELIUS3_X`, … — one name per configured credential. */
const MAX_CREDENTIALS = 9;
function names(suffix: string): string[] {
  return Array.from({ length: MAX_CREDENTIALS }, (_, i) => `HELIUS${i === 0 ? '' : i + 1}_${suffix}`);
}

/**
 * `optionalEnv` semantics, not `??`: an unset CI secret expands to the EMPTY
 * STRING, and `??` accepts that as a configured value — a silent misconfiguration
 * that reads as "set".
 */
function collect(env: Env, keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = (env[key] ?? '').trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

/** Every configured Helius RPC endpoint, preferred first. */
export function heliusRpcUrls(env: Env = process.env): string[] {
  return collect(env, names('RPC_URL'));
}

/**
 * Every configured Helius API key, preferred first.
 *
 * An explicitly named key ranks above one parsed out of an RPC URL: naming a
 * key is a deliberate act, while a URL is configured for its endpoint and
 * happens to carry credentials. A URL with no `api-key` is still a usable RPC
 * endpoint — it simply contributes no key.
 */
export function heliusApiKeys(env: Env = process.env): string[] {
  const fromUrls = heliusRpcUrls(env).map((url) => {
    try { return new URL(url).searchParams.get('api-key') ?? ''; } catch { return ''; }
  });
  return collect(
    { ...env, ...Object.fromEntries(fromUrls.map((key, i) => [`__URL_KEY_${i}`, key])) },
    [...names('API_KEY'), ...fromUrls.map((_, i) => `__URL_KEY_${i}`)],
  );
}

/**
 * Whether this status means "this credential cannot serve us" as opposed to
 * "this request was wrong".
 *
 * 429 covers both a rate limit and an exhausted quota; the status does not
 * distinguish them and the right response to either is the same — ask the next
 * credential. 401/402/403 are a dead, unpaid or revoked key.
 */
export function isHeliusKeyExhausted(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429;
}

function statusOf(err: unknown): number {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number') return status;
  // Callers holding only a message (`Helius listWebhooks 429`) still get to
  // rotate — the status is the one number those messages reliably carry.
  const match = /\b(401|402|403|429)\b/.exec(err instanceof Error ? err.message : String(err));
  return match ? Number(match[1]) : 0;
}

/**
 * Run `fn` against each credential until one answers.
 *
 * Only an exhaustion/auth signal advances; every other error propagates
 * untouched, because replaying a malformed payload across every credential
 * turns one broken call into N and hides which one was at fault.
 *
 * Deliberately stateless — nothing records "this one is spent until T". A spent
 * first credential costs one wasted request per call; in exchange there is no
 * cached verdict to go stale when a quota rolls over, and no shared state
 * between the app and CI.
 */
export async function withHeliusKey<T>(
  fn: (apiKey: string) => Promise<T>,
  env: Env = process.env,
): Promise<T> {
  const keys = heliusApiKeys(env);
  if (keys.length === 0) throw new Error('no Helius API key configured');
  let last: unknown;
  for (const key of keys) {
    try {
      return await fn(key);
    } catch (err) {
      if (!isHeliusKeyExhausted(statusOf(err))) throw err;
      last = err;
    }
  }
  throw last;
}
