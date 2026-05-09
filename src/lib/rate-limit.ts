import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import type { NextRequest } from 'next/server';

/**
 * Rate limiting for AgentKarma's public API surface.
 *
 * Primary backend: Upstash Redis (sliding window, cross-process).
 * Fallback: In-memory per-process Map limiter for dev/local.
 *
 * Budgets are intentionally generous — we want external agents, marketplaces,
 * and the embeddable badge widget to call these endpoints. We rate-limit only
 * to stop obvious abuse (scrapers, loops, accidental hot paths).
 */

export type RateLimitName =
  | 'stats'
  | 'score'
  | 'badge'
  | 'explore'
  | 'leaderboard'
  | 'graph'
  | 'search'
  | 'feedback-get'
  | 'agent-history'
  | 'score-refresh'
  | 'wallet-scan-enqueue'
  | 'deck-identify';

type LimitSpec = { limit: number; window: `${number} s` | `${number} m` };

const LIMITS: Record<RateLimitName, LimitSpec> = {
  stats: { limit: 60, window: '1 m' },
  score: { limit: 30, window: '1 m' },
  badge: { limit: 30, window: '1 m' },
  explore: { limit: 180, window: '1 m' },
  leaderboard: { limit: 30, window: '1 m' },
  graph: { limit: 30, window: '1 m' },
  search: { limit: 30, window: '1 m' },
  'feedback-get': { limit: 30, window: '1 m' },
  'agent-history': { limit: 30, window: '1 m' },
  'score-refresh': { limit: 5, window: '1 m' },
  'wallet-scan-enqueue': { limit: 3, window: '1 m' },
  'deck-identify': { limit: 10, window: '1 m' },
};

type LimitResult = {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number; // epoch ms
};

// ---- Upstash backend ----------------------------------------------------

let upstashWarned = false;
function tryBuildUpstash(): ((name: RateLimitName) => Ratelimit) | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (!upstashWarned) {
      console.warn(
        '[rate-limit] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — ' +
          'falling back to in-memory per-process limiter (dev mode).',
      );
      upstashWarned = true;
    }
    return null;
  }

  const redis = new Redis({ url, token });
  const cache = new Map<RateLimitName, Ratelimit>();
  return (name: RateLimitName) => {
    const existing = cache.get(name);
    if (existing) return existing;
    const spec = LIMITS[name];
    const rl = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(spec.limit, spec.window),
      prefix: `agentkarma:rl:${name}`,
      analytics: false,
    });
    cache.set(name, rl);
    return rl;
  };
}

const getUpstash = tryBuildUpstash();

// ---- In-memory fallback -------------------------------------------------

type Bucket = { timestamps: number[] };
const memStore = new Map<string, Bucket>();

function windowMs(spec: LimitSpec): number {
  const [nStr, unit] = spec.window.split(' ');
  const n = Number(nStr);
  return unit === 's' ? n * 1000 : n * 60_000;
}

function memLimit(name: RateLimitName, identifier: string): LimitResult {
  const spec = LIMITS[name];
  const now = Date.now();
  const windowSize = windowMs(spec);
  const key = `${name}:${identifier}`;
  const bucket = memStore.get(key) ?? { timestamps: [] };
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowSize);

  const success = bucket.timestamps.length < spec.limit;
  if (success) bucket.timestamps.push(now);
  memStore.set(key, bucket);

  const oldest = bucket.timestamps[0] ?? now;
  return {
    success,
    limit: spec.limit,
    remaining: Math.max(0, spec.limit - bucket.timestamps.length),
    reset: oldest + windowSize,
  };
}

// Periodic GC to keep the mem map bounded. Cheap — runs at most once per req.
let lastGc = 0;
function maybeGc(): void {
  const now = Date.now();
  if (now - lastGc < 60_000) return;
  lastGc = now;
  for (const [key, bucket] of memStore) {
    if (bucket.timestamps.length === 0) memStore.delete(key);
  }
}

// ---- Public API ---------------------------------------------------------

/**
 * Extract client IP. We're behind Traefik; trust one hop of `x-forwarded-for`.
 * Falls back to `x-real-ip` and finally a constant (shared bucket is fine —
 * it just means a misconfigured proxy triggers the limit faster).
 */
export function getClientIp(request: NextRequest | Request): string {
  const headers = request.headers;
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = headers.get('x-real-ip');
  if (real) return real.trim();
  return 'unknown';
}

export async function checkRateLimit(
  name: RateLimitName,
  identifier: string,
): Promise<LimitResult> {
  if (getUpstash) {
    const rl = getUpstash(name);
    const res = await rl.limit(identifier);
    return {
      success: res.success,
      limit: res.limit,
      remaining: res.remaining,
      reset: res.reset,
    };
  }
  maybeGc();
  return memLimit(name, identifier);
}

/**
 * Open CORS headers for public, read-only GET endpoints.
 *
 * Rationale: the badge widget, marketplaces, and external agents are expected
 * to call these endpoints from arbitrary origins. Writes stay same-origin.
 * Pair this with an `OPTIONS` handler on each route so browsers can preflight
 * non-simple requests.
 */
export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

/**
 * Ready-made 204 response for `OPTIONS` preflight on public-read endpoints.
 */
export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export function rateLimitHeaders(result: LimitResult): Record<string, string> {
  const resetSec = Math.ceil(result.reset / 1000);
  const retryAfter = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(resetSec),
    ...(result.success ? {} : { 'Retry-After': String(retryAfter) }),
  };
}

/**
 * Convenience: run the limit and return either null (allowed, caller continues)
 * or a ready-to-return 429 Response.
 *
 * Callers should still merge the returned headers onto their success response
 * via `rateLimitHeaders(result)` if they want clients to see the budget.
 */
export async function enforceRateLimit(
  name: RateLimitName,
  request: NextRequest | Request,
): Promise<{ ok: true; headers: Record<string, string> } | { ok: false; response: Response }> {
  const ip = getClientIp(request);
  const result = await checkRateLimit(name, ip);
  const headers = rateLimitHeaders(result);
  if (result.success) return { ok: true, headers };

  return {
    ok: false,
    response: new Response(
      JSON.stringify({ error: 'Rate limit exceeded', retryAfter: headers['Retry-After'] }),
      {
        status: 429,
        headers: { ...headers, 'Content-Type': 'application/json' },
      },
    ),
  };
}
