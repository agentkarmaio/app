/**
 * pay.sh skills catalog — fetch + cache layer.
 *
 * Source of truth: https://storage.googleapis.com/pay-skills/v1/skills.json
 * Refreshed every 1h via `unstable_cache` (tag: `paysh-catalog`).
 *
 * Classification heuristic (no live 402 probe, since this runs in the request
 * path):
 *   - hostname endswith `.gateway-402.com`            → mpp (high confidence)
 *   - fqn starts with `solana-foundation/`            → mpp (high confidence)
 *   - service_url hostname matches a known x402 host  → x402 (high confidence)
 *   - otherwise                                       → x402 (low confidence)
 *
 * The "low" confidence flag tells the UI to render the protocol pill with
 * neutral coloring; once Track A2's `refresh-paysh-catalog.ts` lands and
 * harvests live operator addresses, classification accuracy goes to 100%.
 */
import { unstable_cache } from 'next/cache';
import {
  PAYSH_OPERATORS,
  type PayshOperatorId,
} from '@/config/paysh-operators';

const SKILLS_URL = 'https://storage.googleapis.com/pay-skills/v1/skills.json';
const CACHE_TAG = 'paysh-catalog';
const REVALIDATE_SECONDS = 60 * 60; // 1h

/** Raw shape of a single provider entry in skills.json. */
interface PayshCatalogProviderRaw {
  fqn: string;
  title: string;
  description: string;
  use_case?: string;
  category: string;
  service_url: string;
  endpoint_count: number;
  has_metering?: boolean;
  has_free_tier?: boolean;
  min_price_usd: number;
  max_price_usd: number;
  sha?: string;
}

/** Top-level shape of skills.json. */
interface PayshCatalogResponseRaw {
  version: number;
  generated_at: string;
  base_url: string;
  provider_count: number;
  providers: PayshCatalogProviderRaw[];
}

export type PayshProtocolKind = 'x402' | 'mpp';
export type ClassificationConfidence = 'high' | 'low';

/** Normalized, type-safe view of a pay.sh provider. */
export interface PayshCatalogProvider {
  fqn: string;
  name: string;
  description: string;
  category: string;
  serviceUrl: string;
  gatewayHost: string;
  endpointCount: number;
  pricingMin: number;
  pricingMax: number;
  hasFreeTier: boolean;
  hasMetering: boolean;
  classification: PayshProtocolKind;
  classificationConfidence: ClassificationConfidence;
  /** When this provider's gateway maps to a known operator in PAYSH_OPERATORS. */
  paysOperatorId: PayshOperatorId | null;
}

export interface PayshCatalog {
  generatedAt: string;
  providers: PayshCatalogProvider[];
}

/** Known x402 hosts seen in the live catalog as of 2026-05-06.
 *  Anything matching here gets classification confidence "high". */
const KNOWN_X402_HOSTS: ReadonlySet<string> = new Set([
  'x402.api.agentmail.to',
  'x402.dtelecom.org',
  'stablecrypto.dev',
  'api.crushrewards.dev',
  'api.purch.com',
  'x402.quicknode.com',
]);

const MPP_HOST_SUFFIX = '.gateway-402.com';
const MPP_FQN_PREFIX  = 'solana-foundation/';

function safeHostname(serviceUrl: string): string {
  try {
    return new URL(serviceUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function classify(p: PayshCatalogProviderRaw): {
  classification: PayshProtocolKind;
  classificationConfidence: ClassificationConfidence;
  gatewayHost: string;
} {
  const host = safeHostname(p.service_url);

  if (host.endsWith(MPP_HOST_SUFFIX) || p.fqn.startsWith(MPP_FQN_PREFIX)) {
    return { classification: 'mpp', classificationConfidence: 'high', gatewayHost: host };
  }
  if (KNOWN_X402_HOSTS.has(host) || host.startsWith('x402.')) {
    return { classification: 'x402', classificationConfidence: 'high', gatewayHost: host };
  }
  // Default to x402 with low confidence — most non-foundation providers in the
  // current catalog are vanilla x402.
  return { classification: 'x402', classificationConfidence: 'low', gatewayHost: host };
}

/**
 * Map a provider to a known operator id by matching FQN prefix or category.
 * v1 only knows two operators (google-cloud-apis, paysponge) — most of the 75
 * providers will return null. Track A2 will widen this via live probes.
 */
function resolveOperator(p: PayshCatalogProviderRaw): PayshOperatorId | null {
  if (p.fqn.startsWith('solana-foundation/')) return 'google-cloud-apis';
  // No reliable mapping for paysponge from catalog metadata alone — leave null.
  // Future: harvest operator address by probing the 402 challenge response.
  void PAYSH_OPERATORS; // keep import live for type safety
  return null;
}

function normalize(p: PayshCatalogProviderRaw): PayshCatalogProvider {
  const c = classify(p);
  return {
    fqn: p.fqn,
    name: p.title,
    description: p.description,
    category: p.category,
    serviceUrl: p.service_url,
    gatewayHost: c.gatewayHost,
    endpointCount: p.endpoint_count,
    pricingMin: Number(p.min_price_usd),
    pricingMax: Number(p.max_price_usd),
    hasFreeTier: Boolean(p.has_free_tier),
    hasMetering: Boolean(p.has_metering),
    classification: c.classification,
    classificationConfidence: c.classificationConfidence,
    paysOperatorId: resolveOperator(p),
  };
}

async function fetchPayshCatalogUncached(): Promise<PayshCatalog> {
  const res = await fetch(SKILLS_URL, {
    // Belt-and-braces — outer unstable_cache governs revalidation, but this
    // also keeps Next from trying to cache the raw fetch separately.
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`paysh-catalog: skills.json fetch failed (${res.status})`);
  }
  const json = (await res.json()) as PayshCatalogResponseRaw;
  if (!json || !Array.isArray(json.providers)) {
    throw new Error('paysh-catalog: malformed response (no providers array)');
  }
  return {
    generatedAt: json.generated_at,
    providers: json.providers.map(normalize),
  };
}

/**
 * Fetch + cache the pay.sh catalog. Cached for 1h, tagged `paysh-catalog`
 * so it can be invalidated explicitly via `revalidateTag('paysh-catalog')`
 * when a new operator drops or the catalog rotates.
 */
export const fetchPayshCatalog = unstable_cache(
  fetchPayshCatalogUncached,
  ['paysh-catalog-v1'],
  { revalidate: REVALIDATE_SECONDS, tags: [CACHE_TAG] },
);

export const PAYSH_CATALOG_TAG = CACHE_TAG;
