/**
 * Agent Manifest Resolver — Phase H1 (Tier 3 declared identity).
 *
 * Fetches and normalizes agent-declared capability/identity manifests from
 * supported sources. x402-first, not x402-only — each source slots into the
 * same normalized shape (ParsedManifest) regardless of wire format.
 *
 * Priority order (when we add more sources, try each until one resolves):
 *   1. Self-hosted: GET {website}/.well-known/agentkarma.json
 *   2. MCP descriptor: TODO (Phase H1.5)
 *   3. x402 accepts response: TODO (Phase H1.5)
 *
 * The self-hosted spec — an agent publishes `agentkarma.json` at their claimed
 * website and AgentKarma treats it as a declared identity signal (Tier 3,
 * unverified). Shape:
 *
 *   {
 *     "schema":       "agentkarma.v1",
 *     "wallet":       "<solana-address>",     // must match the claimed wallet
 *     "name":         "WeatherBot",
 *     "description":  "Public weather oracle for Solana agents.",
 *     "website":      "https://weatherbot.example",
 *     "github":       "https://github.com/example/weatherbot",
 *     "category":     "data",
 *     "capabilities": ["weather.get", "weather.forecast"],
 *     "endpoints": [
 *       { "kind": "x402",  "url": "https://api.weatherbot.example/x402" },
 *       { "kind": "mcp",   "url": "https://api.weatherbot.example/mcp" },
 *       { "kind": "http",  "url": "https://api.weatherbot.example" }
 *     ]
 *   }
 *
 * All fields except `schema` are optional. When `wallet` is present and matches
 * the claimed wallet, the manifest is counted as "verified" (owner-published).
 */

import type { ParsedManifest, ManifestSourceType } from '@/db/schema';

const FETCH_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 100_000;

export interface ManifestFetchResult {
  sourceType: ManifestSourceType;
  url: string;
  raw: Record<string, unknown>;
  parsed: ParsedManifest;
  /** True when the manifest declares a `wallet` that matches the claimed address. */
  verified: boolean;
}

/**
 * Primary entry point. Given a wallet + its claimed website, try to resolve a
 * self-hosted manifest. Returns null if none is found or parseable.
 */
export async function resolveManifest(
  wallet: string,
  website: string | null | undefined,
): Promise<ManifestFetchResult | null> {
  if (!website) return null;

  let base: URL;
  try {
    base = new URL(website);
  } catch {
    return null;
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') return null;

  const manifestUrl = new URL('/.well-known/agentkarma.json', base).toString();

  const raw = await fetchJson(manifestUrl);
  if (!raw || typeof raw !== 'object') return null;

  const parsed = parseAgentKarmaManifest(raw);
  if (!parsed) return null;

  const declaredWallet = typeof raw.wallet === 'string' ? raw.wallet : null;
  const verified = declaredWallet === wallet;

  return {
    sourceType: 'self_hosted',
    url: manifestUrl,
    raw,
    parsed,
    verified,
  };
}

/**
 * Normalize an AgentKarma manifest to ParsedManifest. Returns null if the raw
 * blob doesn't look like an AgentKarma manifest (no `schema` or unknown schema).
 */
export function parseAgentKarmaManifest(raw: unknown): ParsedManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const schema = typeof obj.schema === 'string' ? obj.schema : null;
  if (!schema || !schema.startsWith('agentkarma.v')) return null;

  const parsed: ParsedManifest = {
    name:        strOrNull(obj.name),
    description: strOrNull(obj.description),
    website:     strOrNull(obj.website),
    github:      strOrNull(obj.github),
    category:    strOrNull(obj.category),
  };

  if (Array.isArray(obj.capabilities)) {
    parsed.capabilities = obj.capabilities
      .filter((c): c is string => typeof c === 'string' && c.length > 0 && c.length < 120)
      .slice(0, 32);
  }

  if (Array.isArray(obj.endpoints)) {
    parsed.endpoints = obj.endpoints
      .filter((e) => e && typeof e === 'object')
      .map((e) => e as Record<string, unknown>)
      .filter((e) => typeof e.kind === 'string' && typeof e.url === 'string')
      .map((e) => {
        const endpoint: { kind: string; url: string; description?: string } = {
          kind: String(e.kind).toLowerCase(),
          url: String(e.url),
        };
        if (typeof e.description === 'string') endpoint.description = e.description;
        return endpoint;
      })
      .slice(0, 16);
  }

  return parsed;
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;

    // Guard against unbounded bodies.
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) return null;

    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 2000) return trimmed.slice(0, 2000);
  return trimmed;
}
