/**
 * AgentKarma A2A Agent Card — discoverable at:
 *   https://agentkarma.io/.well-known/agent-card.json
 *
 * Declares AgentKarma itself as an agent (it is registered on Celo as ERC-8004
 * agentId 9058) whose skills ARE AgentKarma's reputation features. Conforms to
 * the A2A AgentCard shape (protocolVersion 0.3.0), mirroring the format the
 * Celina SDK publishes so A2A-native discovery tooling understands both.
 *
 * Transport: AgentKarma is reachable as an A2A JSON-RPC agent at /a2a
 * (message/send) AND as an MCP server at /mcp (streamable-http); both are
 * declared as interfaces, JSONRPC preferred. Non-routing: the agent answers
 * reputation queries, it never proxies paid calls.
 *
 * Skills are derived from the shared capability catalog (single source of truth
 * shared with the MCP server card). Served via a Next.js rewrite from the
 * canonical `/.well-known/...` URL (App Router hides leading-dot folders).
 */

import { AGENT_SKILLS } from '@/lib/agent-skill-catalog';
import { AK_VALIDATOR } from '@/config/ak-validator';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io';
const MCP_ENDPOINT = `${APP_URL}/mcp`;
const A2A_ENDPOINT = `${APP_URL}/a2a`;

const AGENT_CARD = {
  protocolVersion: '0.3.0',
  name: 'AgentKarma',
  description:
    'The reputation layer for autonomous on-chain agents, exposed as an agent. Query Provider + Consumer Karma, confidence badges, ERC-8004 attestations, and ecosystem stats across Solana, Stellar, Celo, and Arc BEFORE paying or delegating to a counterparty. Read-only and non-routing — AgentKarma scores wallets, it never proxies paid calls. Invoked over A2A JSON-RPC (message/send) at /a2a, or MCP (streamable-http) at /mcp.',
  version: '0.1.0',
  url: A2A_ENDPOINT,
  preferredTransport: 'JSONRPC',
  provider: {
    organization: 'AgentKarma',
    url: APP_URL,
  },
  iconUrl: `${APP_URL}/brand/agentkarma-dark-X.png`,
  documentationUrl: `${APP_URL}/docs/mcp`,
  capabilities: {
    // No A2A SSE streaming: /a2a implements message/send only (message/stream
    // returns -32601). The /mcp interface's streamable-http is a separate MCP
    // transport, unrelated to this A2A streaming capability.
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  defaultInputModes: ['text', 'data'],
  defaultOutputModes: ['text', 'data'],
  skills: AGENT_SKILLS.map((s) => ({
    id: s.id,
    name: s.title,
    description: s.description,
    tags: s.tags,
    examples: s.examples,
  })),
  additionalInterfaces: [
    { url: A2A_ENDPOINT, transport: 'JSONRPC' },
    { url: MCP_ENDPOINT, transport: 'MCP' },
  ],
  // AgentKarma's own on-chain identity — it is itself a registered ERC-8004
  // agent, dogfooding the registry it indexes.
  extensions: {
    agentkarma: {
      a2aEndpoint: A2A_ENDPOINT,
      mcpEndpoint: MCP_ENDPOINT,
      mcpServerCard: `${APP_URL}/.well-known/mcp/server-card.json`,
      restApi: `${APP_URL}/api/v2/score`,
      nonRouting: true,
      onchainIdentity: {
        chain: AK_VALIDATOR.chain,
        agentId: AK_VALIDATOR.agentId,
        identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
        controller: AK_VALIDATOR.controller,
        agentUri: `${APP_URL}/.well-known/agent.json`,
      },
    },
  },
};

export function GET() {
  return Response.json(AGENT_CARD, {
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
