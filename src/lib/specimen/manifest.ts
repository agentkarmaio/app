/**
 * agentkarma.json — Tier 3 declared identity manifest.
 *
 * Resolver consumes this at /agentkarma.json. Format is the AgentKarma
 * self-hosted manifest shape from web/docs/SIGNAL-ARCHITECTURE.md and the
 * RFC §6. Phase H1 indexer parses the same fields.
 */

import {
  SPECIMEN_PROVIDER_ADDRESS,
  SPECIMEN_PRICE_USDC,
} from '@/config/specimen';

export interface AgentManifest {
  name: string;
  wallet: string;
  description: string;
  website: string;
  category: string;
  capabilities: string[];
  endpoints: Array<{ kind: string; url: string; description?: string }>;
  pricing: { asset: string; amount: number; per: string };
  declaredAt: string;
}

export function buildManifest(baseUrl: string): AgentManifest {
  return {
    name: 'AgentKarma Specimen',
    wallet: SPECIMEN_PROVIDER_ADDRESS,
    description:
      'Reference x402-compatible micro-API hosted by AgentKarma to exercise the full reputation pipeline (payment → indexer → scoring → 8004 attestation) end-to-end on Solana mainnet.',
    website: 'https://agentkarma.io',
    category: 'utility',
    capabilities: ['echo', 'quote'],
    endpoints: [
      { kind: 'http', url: `${baseUrl}/echo`,  description: 'Returns a deterministic echo payload, gated by a USDC micropayment.' },
      { kind: 'http', url: `${baseUrl}/quote`, description: 'Returns a rotating quote, gated by a USDC micropayment.' },
    ],
    pricing: { asset: 'USDC', amount: SPECIMEN_PRICE_USDC, per: 'request' },
    declaredAt: new Date().toISOString(),
  };
}
