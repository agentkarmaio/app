/**
 * AgentKarma MCP Server — streamable-http transport.
 *
 * Exposes the read-only Karma surface as an MCP server at `/mcp`. Designed to
 * sit alongside pay.sh's MCP server: pay.sh's `curl` tool MAKES paid calls,
 * AgentKarma's tools answer the prior question — "should I trust this agent
 * before paying?".
 *
 * Non-routing invariant (RFC §12): we score, never proxy. None of these tools
 * make outbound API calls on behalf of the caller.
 *
 * Two-faced invariant: every wallet response carries Provider Karma AND
 * Consumer Karma — never a single collapsed score.
 *
 * Transport: WebStandardStreamableHTTPServerTransport in stateless mode. Each
 * request gets a fresh transport, McpServer is reused via a module-level
 * singleton. This works on any runtime that supports Web Standards (Next.js
 * App Router included).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import {
  resolveKarma,
  resolveAttestations,
  searchAgents,
} from '@/lib/karma-resolver';
import { readAgent, aggregateFeedback } from '@/integrations/erc8004-celo';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// --- MCP server (singleton) -----------------------------------------------

const SERVER_INFO = {
  name: 'agentkarma',
  title: 'AgentKarma MCP server',
  version: '0.1.0',
} as const;

const SERVER_INSTRUCTIONS = [
  'AgentKarma is the reputation layer for autonomous on-chain agents on Solana.',
  'Use these tools to look up trust signals BEFORE paying or delegating to a',
  'wallet — every response carries two-faced karma (provider + consumer) and a',
  'confidence badge (receipt-backed / behavior-inferred / declared).',
  'AgentKarma does not proxy paid calls. For payment, use pay.sh.',
].join(' ');

export const walletSchema = z
  .string()
  .min(32)
  .max(56)
  .describe('On-chain agent wallet address: Solana base58 (32–44 chars) or Stellar StrKey G-address (56 chars).');
const walletShape: { wallet: typeof walletSchema } = { wallet: walletSchema };

/**
 * Build a fresh `McpServer` per request. The SDK's high-level server wraps a
 * single underlying `Protocol` and refuses to re-connect once a transport is
 * attached, so we cannot share one instance across stateless requests. The
 * cost is just allocating + registering the tools — microseconds.
 */
function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server);
  return server;
}

function readOnly() {
  return { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
}

function registerTools(server: McpServer): void {
  // --- get_karma --------------------------------------------------------
  server.registerTool(
    'get_karma',
    {
      title: 'Get Karma (both faces)',
      description:
        'Look up the full Karma snapshot for a Solana wallet: provider score, consumer score, confidence badge, and autonomy. Use this BEFORE paying an agent or accepting a request from one.',
      inputSchema: walletShape,
      annotations: readOnly(),
    },
    async ({ wallet: addr }) => {
      const snap = await resolveKarma(addr);
      if (!snap) return notFound(addr);
      return jsonResult({
        address: snap.address,
        provider: faceJson(snap.provider),
        consumer: faceJson(snap.consumer),
        confidenceBadge: snap.confidenceBadge,
        autonomy: snap.autonomy,
        identity: snap.identity,
        txCount: snap.txCount,
        lastActive: snap.lastActive,
        profileUrl: profileUrl(addr),
      });
    },
  );

  // --- get_provider_karma ----------------------------------------------
  server.registerTool(
    'get_provider_karma',
    {
      title: 'Get Provider Karma',
      description:
        'Provider face only — "If I pay this agent, will it deliver?". Driven primarily by Tier 1 receipt-gated attestations and Tier 3 declared identity.',
      inputSchema: walletShape,
      annotations: readOnly(),
    },
    async ({ wallet: addr }) => {
      const snap = await resolveKarma(addr);
      if (!snap) return notFound(addr);
      return jsonResult({
        address: snap.address,
        provider: faceJson(snap.provider),
        confidenceBadge: snap.provider.confidenceBadge,
        autonomy: snap.autonomy,
        txCount: snap.txCount,
        lastActive: snap.lastActive,
        profileUrl: profileUrl(addr),
      });
    },
  );

  // --- get_consumer_karma ----------------------------------------------
  server.registerTool(
    'get_consumer_karma',
    {
      title: 'Get Consumer Karma',
      description:
        'Consumer face only — "If I take work from this agent, will it pay me cleanly?". Driven primarily by Tier 2 payment behavior (success rate, volume, cadence).',
      inputSchema: walletShape,
      annotations: readOnly(),
    },
    async ({ wallet: addr }) => {
      const snap = await resolveKarma(addr);
      if (!snap) return notFound(addr);
      return jsonResult({
        address: snap.address,
        consumer: faceJson(snap.consumer),
        confidenceBadge: snap.consumer.confidenceBadge,
        autonomy: snap.autonomy,
        txCount: snap.txCount,
        lastActive: snap.lastActive,
        profileUrl: profileUrl(addr),
      });
    },
  );

  // --- get_confidence ---------------------------------------------------
  server.registerTool(
    'get_confidence',
    {
      title: 'Get confidence badge',
      description:
        'Return the confidence badge plus the per-tier signal breakdown that produced it. Badges: "receipt-backed" (Tier 1 dominant), "behavior-inferred" (Tier 2 dominant), "declared" (Tier 3 only).',
      inputSchema: walletShape,
      annotations: readOnly(),
    },
    async ({ wallet: addr }) => {
      const snap = await resolveKarma(addr);
      if (!snap) return notFound(addr);
      return jsonResult({
        address: snap.address,
        badge: snap.confidenceBadge,
        provider: {
          badge: snap.provider.confidenceBadge,
          tierAggregates: snap.provider.tierAggregates,
        },
        consumer: {
          badge: snap.consumer.confidenceBadge,
          tierAggregates: snap.consumer.tierAggregates,
        },
      });
    },
  );

  // --- search_agents ----------------------------------------------------
  server.registerTool(
    'search_agents',
    {
      title: 'Search agents by wallet substring',
      description:
        'Find agent wallets matching a substring of the address (case-insensitive). Returns up to `limit` results ranked by score.',
      inputSchema: {
        query: z.string().min(3).describe('Substring of the wallet address (≥3 chars).'),
        limit: z.number().int().min(1).max(50).optional()
          .describe('Max results (1–50, default 8).'),
      },
      annotations: readOnly(),
    },
    async ({ query, limit }) => {
      const results = await searchAgents(query, limit ?? 8);
      return jsonResult({
        query,
        count: results.length,
        results: results.map((r) => ({
          address: r.address,
          score: r.score,
          trustTier: r.trustTier,
          txCount: r.txCount,
          profileUrl: profileUrl(r.address),
        })),
      });
    },
  );

  // --- get_celo_agent ---------------------------------------------------
  server.registerTool(
    'get_celo_agent',
    {
      title: 'Get Celo agent (ERC-8004)',
      description:
        'Look up a Celo ERC-8004 agent by its agentId (uint256 NFT tokenId). Returns the IdentityRegistry record (owner, agentURI, declared services from the agent registration JSON) plus aggregate ReputationRegistry feedback (count, average score, recent records). Use this to preflight any agent operating on Celo — same primitive as the Solana karma tools, just on EVM rails.',
      inputSchema: {
        agentId: z
          .number()
          .int()
          .positive()
          .describe('ERC-8004 agentId on Celo mainnet (positive integer).'),
      },
      annotations: readOnly(),
    },
    async ({ agentId }) => {
      const id = BigInt(agentId);
      const [agent, agg] = await Promise.all([
        readAgent(id),
        aggregateFeedback(id).catch(() => null),
      ]);
      if (!agent) {
        return {
          isError: true,
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'celo_agent_not_found',
              agentId,
              message: `No agent registered with id ${agentId} in Celo IdentityRegistry.`,
            }),
          }],
        };
      }
      return jsonResult({
        chain: 'celo',
        agentId,
        owner: agent.owner,
        agentWallet: agent.agentWallet,
        tokenURI: agent.tokenURI,
        registration: agent.registration ?? null,
        registrationError: agent.registrationError,
        reputation: agg
          ? {
              count: agg.count,
              average: agg.average,
              records: agg.records.map((r) => ({
                client: r.client,
                value: r.value,
                tag1: r.tag1,
                tag2: r.tag2,
                revoked: r.revoked,
              })),
            }
          : null,
        explorerUrls: {
          celoscan: `https://celoscan.io/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a=${agentId}`,
          eightthousandfourscan: `https://8004scan.io/agent/${agentId}`,
          agentkarma: `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io'}/api/v2/celo/${agentId}`,
        },
      });
    },
  );

  // --- get_attestations -------------------------------------------------
  server.registerTool(
    'get_attestations',
    {
      title: 'Get attestations',
      description:
        'Return ERC-8004 on-chain attestations and voluntary Tier 1 / Tier 3 signal events for a wallet. Tier 1 = receipt-gated (e.g. x402 / pay.sh-routed). Tier 3 = declared identity (manifests, claims).',
      inputSchema: {
        wallet: walletSchema,
        limit: z.number().int().min(1).max(200).optional()
          .describe('Max signal events returned (1–200, default 50).'),
      },
      annotations: readOnly(),
    },
    async ({ wallet: addr, limit }) => {
      const bundle = await resolveAttestations(addr, limit ?? 50);
      return jsonResult(bundle);
    },
  );
}

function faceJson(b: { score: number; trustTier: string; confidenceBadge: string; hasSignal: boolean; metrics: Record<string, number> | null; tierAggregates: Record<string, number | null> | null }) {
  return {
    score: b.score,
    trustTier: b.trustTier,
    confidenceBadge: b.confidenceBadge,
    hasSignal: b.hasSignal,
    metrics: b.metrics,
    tierAggregates: b.tierAggregates,
  };
}

function profileUrl(addr: string): string {
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io';
  return `${origin}/agent/${addr}`;
}

function jsonResult(payload: unknown) {
  const text = JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

function notFound(addr: string) {
  return {
    isError: true,
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        error: 'wallet_not_found',
        wallet: addr,
        message: 'No indexed transactions or wallet record found. AgentKarma indexes pay.sh / x402 / MPP-on-Solana receipts; wallets without on-chain agent activity won\'t appear.',
      }),
    }],
  };
}

// --- HTTP route handlers --------------------------------------------------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version',
} as const;

async function handle(request: Request): Promise<Response> {
  // Stateless: each request gets a fresh transport. No session ID is required
  // by callers — fine for Claude Desktop / Cursor / Continue and for Cloudflare-
  // style edge runtimes if we ever switch.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await buildServer().connect(transport);
  const response = await transport.handleRequest(request);

  // Layer CORS onto the SDK response (it doesn't add them by default).
  const merged = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) merged.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

export async function POST(request: Request) {
  return handle(request);
}

export async function GET(request: Request) {
  // Real MCP clients open a GET SSE stream and carry one of: Accept:
  // text/event-stream, an Mcp-Session-Id, or an Mcp-Protocol-Version header.
  // Vanilla liveness probes (8004scan, uptime checkers, browsers) carry none
  // of these — return a friendly 200 discovery pointer instead of letting the
  // SDK 4xx the probe and flag the endpoint Unhealthy.
  const accept = request.headers.get('accept') ?? '';
  const isMcpClient =
    accept.includes('text/event-stream') ||
    request.headers.get('mcp-session-id') !== null ||
    request.headers.get('mcp-protocol-version') !== null;

  if (!isMcpClient) {
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io';
    return Response.json(
      {
        server: SERVER_INFO.name,
        title: SERVER_INFO.title,
        version: SERVER_INFO.version,
        transport: 'streamable-http',
        protocolVersion: '2025-06-18',
        hint: 'POST JSON-RPC messages to this endpoint to interact with the MCP server.',
        serverCard: `${origin}/.well-known/mcp/server-card.json`,
        docs: `${origin}/docs/mcp`,
      },
      {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900',
        },
      },
    );
  }
  return handle(request);
}

export async function DELETE(request: Request) {
  return handle(request);
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
