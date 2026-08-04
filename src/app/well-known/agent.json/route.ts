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

import { AK_VALIDATOR, AK_STELLAR } from '@/config/ak-validator';
import { IDENTITY_REGISTRY_CELO } from '@/integrations/erc8004-celo';
import { IDENTITY_REGISTRY_ARC } from '@/integrations/erc8004-arc';
import { STELLAR_IDENTITY_REGISTRY } from '@/integrations/stellar-config';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io';

/** AK's Arc controller — owns Arc-testnet ERC-8004 agentId 72077. */
const AK_ARC_CONTROLLER = '0xeE2a20AEF0f5F9B52FC334806256014F4DDcB8fc';

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
      name: 'a2a-agent-card',
      endpoint: `${APP_URL}/.well-known/agent-card.json`,
      version: '0.3.0',
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
  // On-chain ERC-8004 registrations (CAIP-scoped registry references). The
  // Stellar entry appears here only once the registration is executed — this
  // array asserts what IS on-chain, never what is planned.
  registrations: [
    { agentId: AK_VALIDATOR.agentId, agentRegistry: `eip155:42220:${IDENTITY_REGISTRY_CELO}` },
    { agentId: 72077, agentRegistry: `eip155:5042002:${IDENTITY_REGISTRY_ARC}` },
    ...(AK_STELLAR.agentId != null
      ? [{ agentId: AK_STELLAR.agentId, agentRegistry: `stellar:pubnet:${STELLAR_IDENTITY_REGISTRY}` }]
      : []),
  ],
  // Every chain identity AK operates, incl. the account that signs there —
  // lets a verifier bind any AK-authored on-chain action back to this file.
  // `status: 'pending'` = account is disclosed but not yet registered on that
  // chain's IdentityRegistry (flips to 'registered' + agentId on execution).
  identities: [
    {
      chain: 'celo',
      status: 'registered',
      agentId: AK_VALIDATOR.agentId,
      address: AK_VALIDATOR.controller,
      identityRegistry: IDENTITY_REGISTRY_CELO,
    },
    {
      chain: 'arc',
      network: 'testnet',
      status: 'registered',
      agentId: 72077,
      address: AK_ARC_CONTROLLER,
      identityRegistry: IDENTITY_REGISTRY_ARC,
    },
    {
      chain: 'stellar',
      network: 'pubnet',
      status: AK_STELLAR.agentId != null ? 'registered' : 'pending',
      agentId: AK_STELLAR.agentId,
      address: AK_STELLAR.account,
      identityRegistry: STELLAR_IDENTITY_REGISTRY,
      scheme: AK_STELLAR.scheme,
    },
  ],
  // Disclosed validator role: AK publishes openly-attributed metadata-quality
  // attestations on Celo's ReputationRegistry. These are AK-authored oracle
  // signals, NOT independent third-party reviews. Full disclosure: /validator.
  //
  // The `signers` array publicly binds EVERY wallet AK signs giveFeedback from,
  // so a verifier reading this file can prove an on-chain attestation came from
  // AK (not an anonymous third party impersonating AK). Both addresses are
  // single-sourced from src/config/ak-validator.ts (AK_RATER_ADDRESSES), by
  // least-privilege design: the controller is cold and owns the identity +
  // treasury; the validator is the hot operational signer for automated batches.
  validator: {
    role: 'erc8004-reputation-validator',
    chain: AK_VALIDATOR.chain,
    disclosure: `${APP_URL}/validator`,
    agentId: AK_VALIDATOR.agentId,
    controllerAddress: AK_VALIDATOR.controller,
    validatorAddress: AK_VALIDATOR.validator,
    reputationRegistry: AK_VALIDATOR.reputationRegistry,
    scheme: AK_VALIDATOR.scheme,
    attestationsAreIndependent: false,
    signers: [
      {
        address: AK_VALIDATOR.controller,
        role: 'controller',
        custody: 'cold',
        note: 'Owns ERC-8004 identity + treasury. Seeded AK\'s early attestations.',
      },
      {
        address: AK_VALIDATOR.validator,
        role: 'operational-signer',
        custody: 'hot',
        note: 'Dedicated signer for AK\'s automated metadata-quality attestations.',
      },
    ],
  },
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
