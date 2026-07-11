/**
 * Metadata-quality score for an ERC-8004 agent (chain-agnostic).
 *
 * AK is uniquely positioned to assess whether an on-chain registered agent
 * has high-quality declared metadata. This sits in AK's Tier 3 framework
 * (declared identity) — orthogonal to receipt-gated Tier 1 and behavioral
 * Tier 2. It is a REGISTRATION-QUALITY signal, NOT a behavioral judgement and
 * NOT a "is this a good agent" verdict. Score is 0-100, fully DETERMINISTIC,
 * and a PURE function of the registration JSON (plus the agentURI string for
 * the tamper-resistance check) — same input always yields the same score. No
 * network access, no clock, no randomness. Endpoint reachability is
 * deliberately EXCLUDED (it would be non-deterministic + require network +
 * carry SSRF risk); a liveness signal, if ever added, must be a separate
 * OPTIONAL flag and must never fold into this score.
 *
 * Scheme: `agentkarma_metadata v0.2` — chain-agnostic. The same registration
 * JSON shape (ERC-8004 spec §registration-v1) is published on Celo (via the
 * NFT tokenURI), Stellar (via the IdentityRegistry agentURI), and Arc; this
 * scorer reads any of them through a structural `MetadataAgent` input type.
 *
 * Scoring breakdown (max 100):
 *   15  resolves              registration JSON resolves and parses as JSON
 *   10  typeCorrect           `type` field equals ERC-8004 v1 spec URL
 *    8  name                  non-empty `name`
 *   12  descriptionSubstance  substantive description (multi-sentence + length);
 *                             6 partial when present but thin
 *    7  image                 `image` URL declared
 *    3  imageUrlValid         declared image is a well-formed https/ipfs/data URL
 *    8  services              ≥1 service with name + endpoint
 *    8  serviceRichness       ≥2 services OR a declared x402/MCP/typed capability
 *    6  endpointUrlValid      every service endpoint is a well-formed https/ipfs URL
 *    8  activeAndTrust        `active: true` AND `supportedTrust` non-empty
 *   10  tamperResistance      agentURI/tokenURI is content-addressed (ipfs:/data:)
 *                             rather than a mutable https URL
 *    5  crossChain            ≥1 cross-chain `registrations` entry
 *
 * v0.2 vs v0.1 (the 26 existing on-chain attestations are v0.1; AK skips
 * already-rated agents, so they are never rewritten — this rubric describes
 * the CURRENT scorer only):
 *   - split the old combined "name + description (15)" into `name` (8) and a
 *     graded `descriptionSubstance` (12) that rewards real, multi-sentence copy
 *   - added `imageUrlValid`, `serviceRichness`, `endpointUrlValid`,
 *     `tamperResistance` as new ERC-8004 quality signals
 *   - rebalanced every weight to keep the max at exactly 100
 */

import type { CeloAgent, AgentRegistrationFile } from '@/integrations/erc8004-celo';

const SPEC_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

// A description clears the FULL substance bar when it reads like real prose:
// long enough to carry information AND split across more than one sentence.
const DESC_FULL_MIN_CHARS = 120;
const DESC_PARTIAL_MIN_CHARS = 30;

export interface MetadataQualityResult {
  score: number;
  breakdown: Record<string, number>;
  /** Human-readable explanation, suitable for off-chain feedback payload. */
  notes: string[];
}

/** One rubric dimension: its breakdown key, label, max points, and the
 *  one-line deterministic check it performs. Single source of truth shared by
 *  the scorer, the /celo methodology table, and the per-agent breakdown UI so
 *  none of them can drift from the others. Order = display order. */
export interface RubricDimension {
  key: string;
  label: string;
  max: number;
  checks: string;
}

/** The v0.2 rubric, in display order. Sums to 100 (asserted by the scorer
 *  test). Keys match the `breakdown` map returned by {@link scoreMetadataQuality}. */
export const METADATA_RUBRIC: readonly RubricDimension[] = [
  { key: 'resolves',             label: 'Resolves',              max: 15, checks: 'Registration JSON resolves and parses' },
  { key: 'typeCorrect',          label: 'Spec type',             max: 10, checks: '`type` equals the ERC-8004 v1 registration spec URL' },
  { key: 'name',                 label: 'Name',                  max: 8,  checks: 'Non-empty `name`' },
  { key: 'descriptionSubstance', label: 'Description substance', max: 12, checks: 'Multi-sentence, informative description (6 pts if present but thin)' },
  { key: 'image',                label: 'Image',                 max: 7,  checks: 'An `image` URL is declared' },
  { key: 'imageUrlValid',        label: 'Image URL valid',       max: 3,  checks: 'Image URL is well-formed https / ipfs / data (not plain http)' },
  { key: 'services',             label: 'Services',              max: 8,  checks: '≥1 service with a name and endpoint' },
  { key: 'serviceRichness',      label: 'Service richness',      max: 8,  checks: '≥2 services, or a declared x402 / MCP / typed capability' },
  { key: 'endpointUrlValid',     label: 'Endpoint URLs valid',   max: 6,  checks: 'Every service endpoint is a well-formed https / ipfs URL' },
  { key: 'activeAndTrust',       label: 'Active + trust',        max: 8,  checks: '`active: true` and a non-empty `supportedTrust` array' },
  { key: 'tamperResistance',     label: 'Tamper-resistance',     max: 10, checks: 'agentURI is content-addressed (ipfs / ar / data), not a mutable https URL' },
  { key: 'crossChain',           label: 'Cross-chain',           max: 5,  checks: '≥1 cross-chain `registrations` entry' },
] as const;

/** The version string this rubric is published under (mirrors AK_VALIDATOR.scheme.tag2). */
export const METADATA_SCHEME_VERSION = 'v0.2';

/**
 * Structural input for the metadata-quality scorer. Any chain adapter that
 * produces an ERC-8004 registration JSON (Celo `CeloAgent`, Stellar
 * `StellarAgent`, etc.) conforms. The scorer reads the registration JSON plus,
 * for the tamper-resistance dimension, the URI the registration was fetched
 * from (`tokenURI` on Celo/Arc, `agentURI` on Stellar — either field works;
 * `CeloAgent.tokenURI` satisfies this structurally).
 */
export interface MetadataAgent {
  registration?: AgentRegistrationFile | null;
  registrationError?: string;
  /** The on-chain pointer the registration was fetched from (tokenURI). */
  tokenURI?: string;
  /** Alias accepted from non-EVM adapters (Stellar IdentityRegistry agentURI). */
  agentURI?: string;
}

/** True when `u` parses as a URL whose scheme is one of `schemes`. Pure. */
function hasUrlScheme(u: string, schemes: readonly string[]): boolean {
  const v = u.trim().toLowerCase();
  return schemes.some((s) => v.startsWith(s));
}

/** A well-formed, non-mutable-or-https location for an endpoint/image asset. */
function isWellFormedAssetUrl(u: string): boolean {
  if (!u || typeof u !== 'string') return false;
  const v = u.trim();
  // Accept https, ipfs, ar (Arweave) and inline data: — reject http:// (plain),
  // relative paths, and garbage. Parse https to confirm it is structurally valid.
  if (hasUrlScheme(v, ['ipfs://', 'ar://', 'data:'])) return true;
  if (hasUrlScheme(v, ['https://'])) {
    try {
      const url = new URL(v);
      return url.hostname.length > 0;
    } catch {
      return false;
    }
  }
  return false;
}

/** Content-addressed (immutable) location — its bytes can't change under the
 *  declared score. ipfs://, ar://, and inline data: qualify; https:// does not. */
function isContentAddressed(u: string): boolean {
  return hasUrlScheme(u, ['ipfs://', 'ar://', 'data:']);
}

export function scoreMetadataQuality(agent: MetadataAgent | CeloAgent): MetadataQualityResult {
  const breakdown: Record<string, number> = {
    resolves: 0,
    typeCorrect: 0,
    name: 0,
    descriptionSubstance: 0,
    image: 0,
    imageUrlValid: 0,
    services: 0,
    serviceRichness: 0,
    endpointUrlValid: 0,
    activeAndTrust: 0,
    tamperResistance: 0,
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

  breakdown.resolves = 15;
  notes.push('registration JSON resolves');

  if (reg.type === SPEC_TYPE) {
    breakdown.typeCorrect = 10;
    notes.push('type field matches ERC-8004 v1 spec');
  } else if (reg.type) {
    notes.push(`type field present but unexpected: ${reg.type.slice(0, 40)}`);
  } else {
    notes.push('type field missing');
  }

  // --- name (8) ---------------------------------------------------------------
  const name = typeof reg.name === 'string' ? reg.name.trim() : '';
  if (name.length > 0) {
    breakdown.name = 8;
    notes.push('name declared');
  } else {
    notes.push('name missing');
  }

  // --- descriptionSubstance (12, graded) -------------------------------------
  // Reward a real, informative description over a one-word placeholder. Full
  // credit needs both length AND more than one sentence; a present-but-thin
  // description earns half. Sentence count is a deterministic count of
  // terminal punctuation followed by text or end-of-string.
  const desc = typeof reg.description === 'string' ? reg.description.trim() : '';
  const sentenceCount = (desc.match(/[.!?](?:\s|$)/g) ?? []).length;
  const isMultiSentence = sentenceCount >= 2 || (sentenceCount >= 1 && desc.length >= DESC_FULL_MIN_CHARS);
  if (desc.length >= DESC_FULL_MIN_CHARS && isMultiSentence) {
    breakdown.descriptionSubstance = 12;
    notes.push(`description is substantive (${desc.length} chars, ${sentenceCount} sentence(s))`);
  } else if (desc.length >= DESC_PARTIAL_MIN_CHARS) {
    breakdown.descriptionSubstance = 6;
    notes.push(`description present but thin (${desc.length} chars)`);
  } else if (desc.length > 0) {
    notes.push(`description too short to be substantive (${desc.length} chars)`);
  } else {
    notes.push('description missing');
  }

  // --- image (7) + imageUrlValid (3) -----------------------------------------
  const image = typeof reg.image === 'string' ? reg.image.trim() : '';
  if (image.length > 0) {
    breakdown.image = 7;
    notes.push('image URL declared');
    if (isWellFormedAssetUrl(image)) {
      breakdown.imageUrlValid = 3;
      notes.push('image URL is well-formed');
    } else {
      notes.push('image URL is malformed or uses a plain http:// scheme');
    }
  } else {
    notes.push('image URL missing');
  }

  // --- services (8) + serviceRichness (8) + endpointUrlValid (6) --------------
  const services = Array.isArray(reg.services) ? reg.services : [];
  const validServices = services.filter(
    (s) => s && typeof s.name === 'string' && typeof s.endpoint === 'string' && s.endpoint.length > 0,
  );
  if (validServices.length > 0) {
    breakdown.services = 8;
    notes.push(`${validServices.length} service endpoint(s) declared`);

    // Richness: more than one service, OR a typed/x402/MCP capability declared.
    const hasTypedCapability = validServices.some((s) => {
      const ep = s.endpoint.toLowerCase();
      const nm = s.name.toLowerCase();
      return (
        typeof s.version === 'string' && s.version.trim().length > 0
      ) || nm.includes('x402') || nm.includes('mcp') || ep.includes('x402') || ep.includes('mcp');
    });
    if (validServices.length >= 2 || hasTypedCapability || reg.x402Support === true) {
      breakdown.serviceRichness = 8;
      notes.push(
        reg.x402Support === true
          ? 'declares x402 support'
          : validServices.length >= 2
            ? 'multiple service endpoints'
            : 'declares a typed/x402/MCP capability',
      );
    } else {
      notes.push('single untyped service (no richness signal)');
    }

    // Every declared endpoint must be a well-formed https/ipfs URL for credit.
    const allEndpointsValid = validServices.every((s) => isWellFormedAssetUrl(s.endpoint));
    if (allEndpointsValid) {
      breakdown.endpointUrlValid = 6;
      notes.push('all service endpoints are well-formed URLs');
    } else {
      notes.push('one or more service endpoints are malformed / plain-http');
    }
  } else {
    notes.push('no service endpoints declared');
  }

  // --- activeAndTrust (8) -----------------------------------------------------
  const hasTrust = Array.isArray(reg.supportedTrust) && reg.supportedTrust.length > 0;
  if (reg.active === true && hasTrust) {
    breakdown.activeAndTrust = 8;
    notes.push('explicitly active + supportedTrust declared');
  }

  // --- tamperResistance (10) --------------------------------------------------
  // A content-addressed agentURI (ipfs:/ar:/data:) cannot have its bytes
  // silently swapped after the score is published; a mutable https:// pointer
  // can. This is a genuine ERC-8004 integrity signal.
  // `CeloAgent` carries `tokenURI`; non-EVM adapters may pass `agentURI`. Read
  // both structurally — `agentURI` is absent on `CeloAgent`'s type, so go via a
  // widened view rather than a union member access.
  const uri = (agent.tokenURI ?? (agent as { agentURI?: string }).agentURI ?? '').trim();
  if (uri.length > 0 && isContentAddressed(uri)) {
    breakdown.tamperResistance = 10;
    notes.push('agentURI is content-addressed (tamper-resistant)');
  } else if (uri.length > 0) {
    notes.push('agentURI is a mutable https URL (no tamper-resistance credit)');
  }

  // --- crossChain (5) ---------------------------------------------------------
  const xChain = Array.isArray(reg.registrations) ? reg.registrations.length : 0;
  if (xChain > 0) {
    breakdown.crossChain = 5;
    notes.push(`${xChain} cross-chain registration(s)`);
  }

  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { score, breakdown, notes };
}
