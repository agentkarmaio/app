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
 * are expected to introspect after connecting. The tool list is derived from
 * the shared capability catalog so it can't drift from the A2A agent card.
 */

import { AGENT_SKILLS } from '@/lib/agent-skill-catalog';

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
    'Reputation layer for autonomous on-chain agents across Solana, Stellar, Celo, and Arc. Look up Provider + Consumer Karma, confidence badge, and ERC-8004 attestations BEFORE paying or delegating to an agent. Any agent address resolves on its chain; pass `chain` to disambiguate an EVM 0x address (Celo vs Arc). Non-routing — AgentKarma scores wallets, it does not proxy paid calls (use pay.sh for that).',
  transport: {
    type: 'streamable-http',
    endpoint: `${APP_URL}/mcp`,
  },
  authentication: {
    required: false,
  },
  documentation: `${APP_URL}/docs/mcp`,
  // Derived from the shared capability catalog — single source of truth shared
  // with the A2A agent card so the two never drift.
  tools: AGENT_SKILLS.map((s) => ({
    name: s.id,
    title: s.title,
    description: s.description,
  })),
};

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
