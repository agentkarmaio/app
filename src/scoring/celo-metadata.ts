/**
 * Metadata-quality score for an ERC-8004 agent (chain-agnostic).
 *
 * AK is uniquely positioned to assess whether an on-chain registered agent
 * has high-quality declared metadata. This sits in AK's Tier 3 framework
 * (declared identity) — orthogonal to receipt-gated Tier 1 and behavioral
 * Tier 2. Score is 0-100, deterministic, derived solely from the
 * registration JSON fetched at the agent's tokenURI / agentURI.
 *
 * Scheme: `agentkarma_metadata v0.1` — chain-agnostic. The same registration
 * JSON shape (ERC-8004 spec §registration-v1) is published on Celo (via the
 * NFT tokenURI), Stellar (via the IdentityRegistry agentURI), and Arc; this
 * scorer reads any of them through a structural `MetadataAgent` input type.
 *
 * Scoring breakdown (max 100):
 *   20  registration JSON resolves and parses as JSON
 *   20  `type` field equals ERC-8004 v1 spec URL
 *   15  name + description both non-empty
 *   15  image URL declared
 *   15  ≥1 service with name + endpoint
 *   10  `active: true` AND `supportedTrust` array non-empty
 *    5  ≥1 cross-chain `registrations` entry
 */

import type { CeloAgent, AgentRegistrationFile } from '@/integrations/erc8004-celo';

const SPEC_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

export interface MetadataQualityResult {
  score: number;
  breakdown: Record<string, number>;
  /** Human-readable explanation, suitable for off-chain feedback payload. */
  notes: string[];
}

/**
 * Structural input for the metadata-quality scorer. Any chain adapter that
 * produces an ERC-8004 registration JSON (Celo `CeloAgent`, Stellar
 * `StellarAgent`, etc.) conforms — the scorer reads only these two fields.
 */
export interface MetadataAgent {
  registration?: AgentRegistrationFile | null;
  registrationError?: string;
}

export function scoreMetadataQuality(agent: MetadataAgent | CeloAgent): MetadataQualityResult {
  const breakdown: Record<string, number> = {
    resolves: 0,
    typeCorrect: 0,
    nameAndDescription: 0,
    image: 0,
    services: 0,
    activeAndTrust: 0,
    crossChain: 0,
  };
  const notes: string[] = [];

  const reg = agent.registration as AgentRegistrationFile | null | undefined;
  if (!reg) {
    notes.push(
      agent.registrationError
        ? `registration JSON unreachable: ${agent.registrationError}`
        : 'registration JSON missing',
    );
    return { score: 0, breakdown, notes };
  }

  breakdown.resolves = 20;
  notes.push('registration JSON resolves');

  if (reg.type === SPEC_TYPE) {
    breakdown.typeCorrect = 20;
    notes.push('type field matches ERC-8004 v1 spec');
  } else if (reg.type) {
    notes.push(`type field present but unexpected: ${reg.type.slice(0, 40)}`);
  } else {
    notes.push('type field missing');
  }

  const hasName = typeof reg.name === 'string' && reg.name.trim().length > 0;
  const hasDesc = typeof reg.description === 'string' && reg.description.trim().length > 0;
  if (hasName && hasDesc) {
    breakdown.nameAndDescription = 15;
    notes.push('name + description declared');
  } else {
    notes.push(`missing: ${[!hasName && 'name', !hasDesc && 'description'].filter(Boolean).join(', ')}`);
  }

  if (typeof reg.image === 'string' && reg.image.trim().length > 0) {
    breakdown.image = 15;
    notes.push('image URL declared');
  } else {
    notes.push('image URL missing');
  }

  const services = Array.isArray(reg.services) ? reg.services : [];
  const validServices = services.filter(
    (s) => s && typeof s.name === 'string' && typeof s.endpoint === 'string' && s.endpoint.length > 0,
  );
  if (validServices.length > 0) {
    breakdown.services = 15;
    notes.push(`${validServices.length} service endpoint(s) declared`);
  } else {
    notes.push('no service endpoints declared');
  }

  const hasTrust = Array.isArray(reg.supportedTrust) && reg.supportedTrust.length > 0;
  if (reg.active === true && hasTrust) {
    breakdown.activeAndTrust = 10;
    notes.push('explicitly active + supportedTrust declared');
  }

  const xChain = Array.isArray(reg.registrations) ? reg.registrations.length : 0;
  if (xChain > 0) {
    breakdown.crossChain = 5;
    notes.push(`${xChain} cross-chain registration(s)`);
  }

  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { score, breakdown, notes };
}
