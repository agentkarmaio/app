/**
 * AgentKarma agent registration file — ERC-8004 IdentityRegistry references
 * this URI as AK's on-chain agent metadata.
 *
 * Discoverable at:
 *   https://agentkarma.io/.well-known/agent.json
 *
 * Conforms to ERC-8004 registration-v1. AK's controlling Celo wallet
 * (0xCfc0A11C75519FAf85B7872E27733CFaa4295b96) registered against this URI
 * in the Celo IdentityRegistry at 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432.
 *
 * Spec: https://github.com/erc-8004/erc-8004-contracts/blob/master/ERC8004SPEC.md
 */

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io';

const AGENT_REGISTRATION = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'AgentKarma',
  description:
    'Reputation layer for autonomous on-chain agents. Blends four signal tiers — x402 receipts, behavioral evidence, declared identity, social attestation — into a portable Provider + Consumer karma score, plus an orthogonal Autonomy Confidence axis. Non-routing: AK scores wallets, it does not proxy paid calls.',
  image: `${APP_URL}/brand/agentkarma-dark-X.png`,
  x402Support: true,
  active: true,
  supportedTrust: ['reputation'],
  services: [
    {
      name: 'web',
      endpoint: APP_URL,
      version: '1.0',
    },
    {
      name: 'api',
      endpoint: `${APP_URL}/api/v2/score`,
      version: '2.0',
    },
    {
      name: 'mcp',
      endpoint: `${APP_URL}/mcp`,
      version: '2025-06-18',
    },
    {
      name: 'mcp-server-card',
      endpoint: `${APP_URL}/.well-known/mcp/server-card.json`,
    },
    {
      name: 'protocol-rfc',
      endpoint: `${APP_URL}/protocol`,
      version: '0.3',
    },
    {
      name: 'docs',
      endpoint: `${APP_URL}/docs`,
    },
  ],
  registrations: [] as Array<{ agentId: number; agentRegistry: string }>,
} as const;

export function GET() {
  return Response.json(AGENT_REGISTRATION, {
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
