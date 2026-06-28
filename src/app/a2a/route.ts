/**
 * AgentKarma A2A agent endpoint — the runnable side of agentId 9058.
 *
 * Implements the A2A (Agent2Agent) v0.3.0 JSON-RPC `message/send` method over
 * HTTP at /a2a. Another agent sends a message naming an on-chain wallet; this
 * agent resolves that wallet's reputation and replies with an A2A Message
 * carrying a human-readable summary (TextPart) plus the full structured Karma
 * snapshot (DataPart).
 *
 * Parity invariant: resolution + projection go through the SAME exported
 * `resolveForChain` + `fullKarmaJson` the MCP `get_karma` tool uses — the A2A
 * answer is byte-identical to the MCP answer, one source of truth.
 *
 * Read-only, non-routing, public, no auth. We implement message/send only;
 * tasks/* and message/stream return -32601 (honest — no task state here).
 * Errors never leak internals (mirrors the /mcp runTool discipline).
 *
 * The AgentCard at /.well-known/agent-card.json advertises this endpoint as the
 * primary JSONRPC interface (with MCP as a secondary interface).
 */

import { randomUUID } from 'node:crypto';
import {
  resolveForChain,
  fullKarmaJson,
  walletSchema,
  chainSchema,
} from '@/app/mcp/route';
import { enforceRateLimit } from '@/lib/rate-limit';
import { getErc8004Agent } from '@/db/client';
import { getTrustTier } from '@/scoring/index';
import type { Chain } from '@/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
// EVM chains an agentId can live on (the registry mirror covers these).
const EVM_CHAINS: readonly Chain[] = ['celo', 'arc'];

// ── Constants ────────────────────────────────────────────────────────────────
const A2A_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
} as const;

const MAX_BODY_BYTES = 64 * 1024; // A2A message bodies are tiny; hard cap.
const MAX_PARTS = 16; // bound regex/scan work on a public endpoint
const MAX_TEXT_CHARS = 4096;
const ALLOWED_METHODS = new Set(['message/send']);

// JSON-RPC 2.0 error codes (+ A2A uses the standard set for transport errors).
const E = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  // Implementation-defined server-error range (-32000..-32099): rate limiting.
  RATE_LIMITED: -32000,
} as const;

type JsonRpcId = string | number | null;

// ── JSON-RPC envelope helpers ────────────────────────────────────────────────
function rpcResult(id: JsonRpcId, result: unknown, extraHeaders: Record<string, string> = {}) {
  return Response.json({ jsonrpc: '2.0', id, result }, { headers: { ...A2A_CORS, ...extraHeaders } });
}

function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  status = 200,
  extraHeaders: Record<string, string> = {},
) {
  // Per JSON-RPC, application errors still ride HTTP 200; only Content-Type/
  // rate-limit transport problems use a non-200 status. `message` is ALWAYS a
  // static constant — never an interpolated caught error (no leak surface).
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status, headers: { ...A2A_CORS, ...extraHeaders } });
}

/** Build an A2A agent Message result (kind:message, role:agent, text + data). */
function agentMessage(text: string, data: Record<string, unknown>) {
  return {
    kind: 'message' as const,
    role: 'agent' as const,
    messageId: randomUUID(),
    parts: [
      { kind: 'text' as const, text },
      { kind: 'data' as const, data },
    ],
  };
}

// ── Target extraction (exported for tests) ───────────────────────────────────
const ADDR_RE = {
  evm: /\b0x[a-fA-F0-9]{40}\b/,
  stellar: /\bG[A-Z2-7]{55}\b/,
  solana: /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/,
};
const CHAIN_WORD_RE = /\b(solana|sol|celo|stellar|xlm|arc)\b/i;
// "agentId 9604", "agent id 9604", "agent #9604", "agent 9604" — digits must
// closely follow the keyword so "agentkarma 9604" / bare numbers don't match.
const AGENT_ID_RE = /\bagent(?:\s*-?\s*id)?\s*#?\s*(\d{1,9})\b/i;

function normalizeChain(s: string): Chain | undefined {
  const v = s.toLowerCase();
  if (v === 'sol') return 'solana';
  if (v === 'xlm') return 'stellar';
  if (v === 'solana' || v === 'celo' || v === 'stellar' || v === 'arc') return v;
  return undefined;
}

interface A2APart {
  kind?: unknown;
  text?: unknown;
  data?: unknown;
}

/**
 * Pull the target {wallet, chain} from an A2A message. A structured DataPart
 * (`{ kind:'data', data:{ wallet|address|agent, chain } }`) is the deterministic
 * machine path and wins; a free-text TextPart is the fallback for human/LLM
 * phrasing ("karma of 0x… on celo"). Returns wallet:null when none is found.
 */
export function extractTarget(message: { parts?: unknown }): {
  wallet: string | null;
  agentId: number | null;
  chain: Chain | undefined;
} {
  const parts: A2APart[] = Array.isArray(message?.parts) ? (message.parts as A2APart[]).slice(0, MAX_PARTS) : [];

  // 1. Structured DataPart (preferred, deterministic). A wallet address wins
  //    over an agentId in the same part (it's the more specific identifier).
  for (const p of parts) {
    if (p?.kind === 'data' && p.data && typeof p.data === 'object') {
      const d = p.data as Record<string, unknown>;
      const chain = typeof d.chain === 'string' ? normalizeChain(d.chain) : undefined;
      const w = d.wallet ?? d.address ?? d.agent;
      if (typeof w === 'string' && w.trim()) {
        return { wallet: w.trim(), agentId: null, chain };
      }
      const idRaw = d.agentId ?? d.agent_id;
      const id =
        typeof idRaw === 'number'
          ? idRaw
          : typeof idRaw === 'string' && /^\d{1,9}$/.test(idRaw.trim())
            ? Number(idRaw.trim())
            : null;
      if (id != null && Number.isInteger(id) && id > 0) {
        return { wallet: null, agentId: id, chain };
      }
    }
  }

  // 2. Free-text fallback. 0x and G-prefix are format-unique; try them before
  //    the broader base58 pattern. (`??` short-circuits — only the first match.)
  const text = parts
    .filter((p) => p?.kind === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join(' ')
    .slice(0, MAX_TEXT_CHARS);

  const cw = CHAIN_WORD_RE.exec(text);
  const chain = cw ? normalizeChain(cw[1]) : undefined;

  const m = ADDR_RE.evm.exec(text) ?? ADDR_RE.stellar.exec(text) ?? ADDR_RE.solana.exec(text);
  if (m) return { wallet: m[0], agentId: null, chain };

  const idm = AGENT_ID_RE.exec(text);
  return { wallet: null, agentId: idm ? Number(idm[1]) : null, chain };
}

// ── Human summary (exported for tests) ───────────────────────────────────────
/**
 * One-line, two-faced summary for the TextPart. ALWAYS carries Provider AND
 * Consumer (architectural invariant #3 — never collapse to one score). EVM
 * agents are declared-tier, so their consumer face is explicitly Unrated.
 */
export function summarize(karma: Record<string, unknown>): string {
  const addr = karma.address;
  const chain = karma.chain;
  const url = karma.profileUrl;
  const prov = karma.provider as { score?: number | null; trustTier?: string; confidenceBadge?: string } | undefined;
  const provStr = `Provider ${fmtScore(prov?.score)}/100 (${prov?.trustTier}, ${prov?.confidenceBadge})`;

  if ('txCount' in karma) {
    const cons = karma.consumer as { score?: number | null; trustTier?: string } | undefined;
    const consStr =
      cons?.score == null
        ? `Consumer Unrated (${cons?.trustTier})`
        : `Consumer ${cons.score}/100 (${cons.trustTier})`;
    return `AgentKarma — ${addr} on ${chain}: ${provStr}; ${consStr}. ${karma.txCount} indexed tx. ${url}`;
  }
  // EVM declared-tier shape (no txCount; consumer face is null by invariant).
  return `AgentKarma — ${addr} on ${chain}: ${provStr}; Consumer Unrated (declared-tier; payment-behavior signal is Solana-only today). ${url}`;
}

function fmtScore(s: number | null | undefined): string {
  return s == null ? 'Unrated' : String(s);
}

// ── message/send handler (exported + injectable for tests) ───────────────────
export interface MessageSendDeps {
  resolveForChain: typeof resolveForChain;
  fullKarmaJson: typeof fullKarmaJson;
  getErc8004Agent: typeof getErc8004Agent;
}
const DEFAULT_DEPS: MessageSendDeps = { resolveForChain, fullKarmaJson, getErc8004Agent };

export async function handleMessageSend(
  id: JsonRpcId,
  params: unknown,
  extraHeaders: Record<string, string> = {},
  deps: MessageSendDeps = DEFAULT_DEPS,
): Promise<Response> {
  const message = (params as { message?: unknown } | null | undefined)?.message as { parts?: unknown } | undefined;
  const parts = message?.parts;
  if (!message || typeof message !== 'object' || !Array.isArray(parts) || parts.length === 0) {
    return rpcError(id, E.INVALID_PARAMS, 'Invalid params: message with a non-empty parts array is required', 200, extraHeaders);
  }
  if (!parts.every((p) => p && typeof (p as A2APart).kind === 'string')) {
    return rpcError(id, E.INVALID_PARAMS, 'Invalid params: each part requires a string kind', 200, extraHeaders);
  }

  const { wallet, agentId, chain } = extractTarget(message);

  // agentId lookup (no address): resolve the ERC-8004 registry agent directly.
  // Registry agents (fleets / self-owned demo agents) aren't in `wallets`, so
  // they don't resolve by address — only by agentId. Chain disambiguated by
  // probing Celo then Arc when not given.
  if (!wallet && agentId != null) {
    return handleAgentIdLookup(id, agentId, chain, extraHeaders, deps);
  }

  if (!wallet) {
    return rpcResult(
      id,
      agentMessage(
        'Send an on-chain agent wallet address (Solana, Stellar, Celo, or Arc), or an ERC-8004 agentId (e.g. "agentId 9604 on celo"), to look up its AgentKarma reputation.',
        { found: false, reason: 'no_target' },
      ),
      extraHeaders,
    );
  }

  const w = walletSchema.safeParse(wallet);
  const c = chainSchema.safeParse(chain);
  if (!w.success || !c.success) {
    return rpcResult(
      id,
      agentMessage(
        `That does not look like a supported agent address. Provide a Solana, Stellar, Celo, or Arc wallet.`,
        { found: false, reason: 'invalid_address' },
      ),
      extraHeaders,
    );
  }

  let resolved: Awaited<ReturnType<typeof resolveForChain>>;
  try {
    resolved = await deps.resolveForChain(w.data, c.data as Chain | undefined);
  } catch (err) {
    // NON-LEAK: a DB/RPC failure can carry connection strings or hostnames.
    // Log server-side only; return a generic internal error, never the message.
    console.error('[a2a:message/send] resolution error', err);
    return rpcError(id, E.INTERNAL, 'Internal error', 200, extraHeaders);
  }

  if (!resolved) {
    return rpcResult(
      id,
      agentMessage(
        `No indexed activity or registered identity found for ${w.data}.`,
        { found: false, wallet: w.data, chain: c.data ?? null },
      ),
      extraHeaders,
    );
  }

  const karma = deps.fullKarmaJson(resolved, w.data) as Record<string, unknown>;
  return rpcResult(
    id,
    {
      kind: 'message',
      role: 'agent',
      messageId: randomUUID(),
      parts: [
        { kind: 'text', text: summarize(karma) },
        { kind: 'data', data: karma },
      ],
    },
    extraHeaders,
  );
}

// ── agentId lookup (ERC-8004 registry agents) ────────────────────────────────
async function handleAgentIdLookup(
  id: JsonRpcId,
  agentId: number,
  chain: Chain | undefined,
  extraHeaders: Record<string, string>,
  deps: MessageSendDeps,
): Promise<Response> {
  const chains: readonly Chain[] =
    chain && (EVM_CHAINS as readonly string[]).includes(chain) ? [chain] : EVM_CHAINS;
  let row: Record<string, unknown> | null = null;
  let onChain: Chain | undefined;
  try {
    for (const c of chains) {
      const r = await deps.getErc8004Agent(c, agentId);
      if (r) { row = r; onChain = c; break; }
    }
  } catch (err) {
    console.error('[a2a:message/send] registry lookup error', err);
    return rpcError(id, E.INTERNAL, 'Internal error', 200, extraHeaders);
  }
  if (!row || !onChain) {
    return rpcResult(
      id,
      agentMessage(
        `No ERC-8004 agent found for agentId ${agentId}${chain ? ` on ${chain}` : ' on Celo or Arc'}.`,
        { found: false, agentId, chain: chain ?? null },
      ),
      extraHeaders,
    );
  }
  const data = registryAgentJson(row, onChain, agentId);
  return rpcResult(
    id,
    {
      kind: 'message',
      role: 'agent',
      messageId: randomUUID(),
      parts: [
        { kind: 'text', text: summarizeRegistry(data) },
        { kind: 'data', data },
      ],
    },
    extraHeaders,
  );
}

/** Project a cached erc8004_agents mirror row into a two-faced registry-agent JSON. */
function registryAgentJson(row: Record<string, unknown>, chain: Chain, agentId: number) {
  const reg = (row.registration ?? {}) as Record<string, unknown>;
  const score = Number(row.metadata_score ?? 0);
  const feedbackCount = Number(row.feedback_count ?? 0);
  const owner = String(row.owner ?? '');
  const agentWallet = typeof row.agent_wallet === 'string' ? row.agent_wallet : null;
  const address = agentWallet && agentWallet.toLowerCase() !== ZERO_ADDR ? agentWallet : owner;
  const avg = row.feedback_avg;
  return {
    kind: 'registry-agent' as const,
    chain,
    agentId,
    owner,
    agentWallet,
    name: typeof reg.name === 'string' ? reg.name : null,
    // Provider Karma for an ERC-8004 registry agent IS its declared metadata
    // quality (Tier 3). Consumer face is null — EVM agents are declared-tier.
    provider: { score, trustTier: getTrustTier(score), confidenceBadge: 'declared', hasSignal: feedbackCount > 0 },
    consumer: {
      score: null,
      trustTier: 'Unrated',
      confidenceBadge: 'declared',
      hasSignal: false,
      note: 'EVM agents are declared-tier; payment-behavior signal is Solana-only today.',
    },
    onChainFeedback: { count: feedbackCount, average: avg != null ? Number(avg) : null },
    services: Array.isArray(reg.services) ? reg.services : [],
    profileUrl: `${APP_URL}/agent/${address}?agentId=${agentId}&chain=${chain}`,
    explorerUrls: { eightthousandfourscan: `https://8004scan.io/agent/${agentId}` },
  };
}

function summarizeRegistry(d: ReturnType<typeof registryAgentJson>): string {
  const label = d.name ?? `agentId ${d.agentId}`;
  const fb =
    d.onChainFeedback.count > 0
      ? `${d.onChainFeedback.count} on-chain feedback${d.onChainFeedback.average != null ? ` (avg ${d.onChainFeedback.average})` : ''}`
      : 'no on-chain feedback yet';
  return `AgentKarma — ${label} (agentId ${d.agentId}) on ${d.chain}: Provider ${d.provider.score}/100 (${d.provider.trustTier}, declared); Consumer Unrated (declared-tier). ${fb}. ${d.profileUrl}`;
}

// ── HTTP handlers ────────────────────────────────────────────────────────────
export async function OPTIONS() {
  return new Response(null, { status: 204, headers: A2A_CORS });
}

export async function POST(req: Request): Promise<Response> {
  // Rate limit FIRST, before reading the body. Reuses the per-IP 'score' budget
  // (30/min) — same cost profile as /api/v2/score (per-wallet DB + RPC read).
  const gate = await enforceRateLimit('score', req);
  if (!gate.ok) {
    // Convert the limiter's plain 429 into a JSON-RPC 2.0 envelope so A2A clients
    // can parse it; preserve the 429 status + Retry-After / X-RateLimit-* headers.
    const rlHeaders = Object.fromEntries(gate.response.headers.entries());
    return rpcError(null, E.RATE_LIMITED, 'Rate limit exceeded', 429, rlHeaders);
  }
  const rl = gate.headers;

  const ct = req.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    return rpcError(null, E.INVALID_REQUEST, 'Content-Type must be application/json', 415, rl);
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return rpcError(null, E.INVALID_REQUEST, 'Request body too large', 200, rl);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return rpcError(null, E.PARSE, 'Parse error', 200, rl);
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return rpcError(null, E.INVALID_REQUEST, 'Invalid Request', 200, rl);
  }
  const b = body as Record<string, unknown>;
  const id: JsonRpcId = typeof b.id === 'string' || typeof b.id === 'number' ? b.id : null;

  if (b.jsonrpc !== '2.0' || typeof b.method !== 'string') {
    return rpcError(id, E.INVALID_REQUEST, 'Invalid Request', 200, rl);
  }
  if (!ALLOWED_METHODS.has(b.method)) {
    return rpcError(id, E.METHOD_NOT_FOUND, 'Method not found', 200, rl);
  }

  return handleMessageSend(id, b.params, rl);
}
