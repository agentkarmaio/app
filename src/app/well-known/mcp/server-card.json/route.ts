/**
 * AgentKarma MCP Server Card — discoverable at:
 *   https://agentkarma.io/.well-known/mcp/server-card.json
 *
 * Conforms to SEP-1649 (mcp-server-card v1) and mirrors the shape pay.sh uses
 * at `pay.sh/.well-known/mcp/server-card.json` so generic MCP clients that
 * already understand pay.sh's card understand ours too.
 *
 * `.well-known/mcp/server-card.json` is served via a Next.js rewrite to this
 * `well-known/...` route — the App Router treats leading-dot folders as
 * private/hidden, so we colocate the handler under a regular folder and let
 * `next.config.ts` rewrite the canonical URL to it.
 *
 * Tools listed here carry only name + title + description. The full input
 * schemas are exposed at runtime via the MCP `tools/list` request — clients
 * are expected to introspect after connecting.
 */

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io';

const SERVER_CARD = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json',
  version: '1.0',
  protocolVersion: '2025-06-18',
  serverInfo: {
    name: 'agentkarma',
    title: 'AgentKarma MCP server',
    version: '0.1.0',
  },
  description:
    'Reputation layer for autonomous on-chain agents on Solana. Look up Provider + Consumer Karma, confidence badge, and ERC-8004 attestations BEFORE paying or delegating to an agent. Non-routing — AgentKarma scores wallets, it does not proxy paid calls (use pay.sh for that).',
  transport: {
    type: 'streamable-http',
    endpoint: `${APP_URL}/mcp`,
  },
  authentication: {
    required: false,
  },
  documentation: `${APP_URL}/docs/mcp`,
  tools: [
    {
      name: 'get_karma',
      title: 'Get Karma (both faces)',
      description: 'Look up the full Karma snapshot for a wallet — Provider + Consumer scores, confidence badge, and autonomy.',
    },
    {
      name: 'get_provider_karma',
      title: 'Get Provider Karma',
      description: 'Provider face only — "If I pay this agent, will it deliver?".',
    },
    {
      name: 'get_consumer_karma',
      title: 'Get Consumer Karma',
      description: 'Consumer face only — "If I take work from this agent, will it pay me cleanly?".',
    },
    {
      name: 'get_confidence',
      title: 'Get confidence badge',
      description: 'Confidence badge plus per-tier signal breakdown (Tier 1 receipts vs Tier 2 behavior vs Tier 3 declared).',
    },
    {
      name: 'search_agents',
      title: 'Search agents',
      description: 'Find agent wallets by substring of the address. Ranked by score.',
    },
    {
      name: 'get_attestations',
      title: 'Get attestations',
      description: 'ERC-8004 on-chain attestations and voluntary Tier 1 / Tier 3 signal events for a wallet.',
    },
    {
      name: 'get_celo_agent',
      title: 'Get Celo agent (ERC-8004)',
      description: 'Look up a Celo ERC-8004 agent by agentId — IdentityRegistry record + aggregate ReputationRegistry feedback.',
    },
  ],
} as const;

export function GET() {
  return Response.json(SERVER_CARD, {
    headers: {
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
