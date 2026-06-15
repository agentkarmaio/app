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
 *     ],
 *     "tempoAddress": "0xabcdef0123456789abcdef0123456789abcdef01"
 *   }
 *
 * All fields except `schema` are optional. When `wallet` is present and matches
 * the claimed wallet, the manifest is counted as "verified" (owner-published).
 */

import type { ParsedManifest, ManifestSourceType, ManifestSuccessionPlan, SuccessionHeir } from '@/db/schema';
import { isTempoAddress, isChain } from '@/db/schema';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { safeFetchText, SsrfBlockedError } from '@/lib/ssrf';

const FETCH_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 100_000;
// GitHub proof expires after 30 days — prevents replay with a rotated key.
const GITHUB_PROOF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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

  // Verification ladder: a manifest is "verified" if either
  //   (a) its declared `wallet` matches the claimed wallet (self-attestation), OR
  //   (b) a GitHub proof file in the linked repo is signed by the wallet.
  let verified = declaredWallet === wallet;
  if (!verified && parsed.github) {
    verified = await verifyGithubProof(wallet, parsed.github);
  }

  return {
    sourceType: 'self_hosted',
    url: manifestUrl,
    raw,
    parsed,
    verified,
  };
}

// ─── GitHub ownership proof (Phase H2) ────────────────────────────────────────
//
// An agent publishes `AGENTKARMA.md` at the repo root containing:
//
//   AgentKarma: wallet <solana-address> at <unix-ms>
//   <base58 ed25519 signature of the above single line>
//
// We fetch via `raw.githubusercontent.com`, verify the signature against the
// wallet's pubkey, and check the timestamp is within GITHUB_PROOF_MAX_AGE_MS.
// Rotation = republish the file; stale proofs silently fail.

export async function verifyGithubProof(
  wallet: string,
  githubUrl: string,
): Promise<boolean> {
  const repo = parseGithubRepo(githubUrl);
  if (!repo) return false;

  // Try `HEAD` then the common default branches. `HEAD` resolves on most repos.
  const candidates = [
    `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/HEAD/AGENTKARMA.md`,
    `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/main/AGENTKARMA.md`,
    `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/master/AGENTKARMA.md`,
  ];

  for (const url of candidates) {
    const body = await fetchText(url);
    if (!body) continue;
    const ok = verifyProofBody(wallet, body);
    if (ok) return true;
  }
  return false;
}

function parseGithubRepo(url: string): { owner: string; name: string } | null {
  try {
    const u = new URL(url);
    if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null;
    const [owner, name] = u.pathname.split('/').filter(Boolean);
    if (!owner || !name) return null;
    // Strip trailing .git or anything after
    return { owner, name: name.replace(/\.git$/, '') };
  } catch {
    return null;
  }
}

function verifyProofBody(wallet: string, body: string): boolean {
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;

  const msgLine = lines.find((l) => l.startsWith('AgentKarma: wallet '));
  const sigLine = msgLine ? lines[lines.indexOf(msgLine) + 1] : null;
  if (!msgLine || !sigLine) return false;

  // Parse "AgentKarma: wallet <pubkey> at <ts>"
  const match = msgLine.match(/^AgentKarma: wallet (\S+) at (\d+)$/);
  if (!match) return false;
  const [, declared, tsStr] = match;
  if (declared !== wallet) return false;

  const ts = Number(tsStr);
  if (!Number.isFinite(ts)) return false;
  if (Date.now() - ts > GITHUB_PROOF_MAX_AGE_MS) return false;
  if (ts > Date.now() + 60_000) return false; // reject far-future timestamps

  try {
    const pubkey = new PublicKey(wallet).toBytes();
    const msgBytes = new TextEncoder().encode(msgLine);
    const sigBytes = bs58Decode(sigLine);
    return nacl.sign.detached.verify(msgBytes, sigBytes, pubkey);
  } catch {
    return false;
  }
}

async function fetchText(url: string): Promise<string | null> {
  // SSRF-guarded: validates the host (and every redirect hop) against private /
  // loopback / link-local / metadata ranges before connecting. https-only in
  // production. Returns null on block to preserve "no proof found" semantics.
  try {
    return await safeFetchText(url, {
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBodyBytes: MAX_BODY_BYTES,
    });
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      console.warn('[manifest] SSRF-blocked fetch:', err.message);
      return null;
    }
    return null;
  }
}

// Minimal base58 decode — duplicated from claim route to avoid a client-side
// dep; a shared helper can land when a third caller appears.
function bs58Decode(str: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const BASE = BigInt(58);
  let num = BigInt(0);
  for (const char of str) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base58 character: ${char}`);
    num = num * BASE + BigInt(index);
  }
  const hex = num.toString(16).padStart(2, '0');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  let leadingZeros = 0;
  for (const char of str) {
    if (char === '1') leadingZeros++;
    else break;
  }
  const result = new Uint8Array(leadingZeros + bytes.length);
  result.set(bytes, leadingZeros);
  return result;
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
    // Tier 3 declared MPP/Tempo address — validated but not verified. Cross-rail
    // ownership proofs (signed pairing statement) are future work.
    tempoAddress: isTempoAddress(obj.tempoAddress) ? (obj.tempoAddress as string) : null,
  };

  if (Array.isArray(obj.capabilities)) {
    parsed.capabilities = obj.capabilities
      .filter((c): c is string => typeof c === 'string' && c.length > 0 && c.length < 120)
      .slice(0, 32);
  }

  const succession = parseManifestSuccession(obj.succession);
  if (succession) parsed.succession = succession;

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
  // SSRF-guarded fetch (see fetchText). The manifest URL derives from a wallet-
  // declared website reachable via the PUBLIC unauthenticated refresh endpoint,
  // so the host must be re-validated on every redirect hop before connecting.
  let text: string | null;
  try {
    text = await safeFetchText(url, {
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBodyBytes: MAX_BODY_BYTES,
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      console.warn('[manifest] SSRF-blocked fetch:', err.message);
    }
    return null;
  }
  if (text === null) return null;

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Loosely shape-check a manifest `succession` block. Carry-through only — the
 * full bounds/heir/self-heir validation runs in the succession write-path
 * (successions/validate.ts) at declare time. Returns null when the block is
 * absent or structurally unusable so a malformed will never blocks the rest of
 * the manifest from resolving.
 */
function parseManifestSuccession(raw: unknown): ManifestSuccessionPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const intervalSeconds = Number(obj.intervalSeconds ?? obj.interval_seconds);
  if (!Number.isFinite(intervalSeconds)) return null;

  if (!Array.isArray(obj.heirs) || obj.heirs.length === 0) return null;
  const heirs: SuccessionHeir[] = [];
  for (const h of obj.heirs) {
    if (!h || typeof h !== 'object') continue;
    const he = h as Record<string, unknown>;
    if (typeof he.address !== 'string' || !isChain(he.chain)) continue;
    const heir: SuccessionHeir = { address: he.address, chain: he.chain };
    if (he.share != null && Number.isFinite(Number(he.share))) heir.share = Number(he.share);
    if (typeof he.label === 'string') heir.label = he.label;
    heirs.push(heir);
  }
  if (heirs.length === 0) return null;

  return { intervalSeconds, heirs };
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 2000) return trimmed.slice(0, 2000);
  return trimmed;
}
