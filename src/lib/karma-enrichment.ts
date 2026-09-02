/**
 * Enriched score response — PURE block builders + the deterministic `explain`
 * generator. One shape for every karma read surface (v2 score route, MCP
 * `get_karma`, A2A `message/send`), so a partner reading a registry-only agent
 * sees the evidence AK already holds (registry identity, declared-metadata
 * rubric, ERC-8004 feedback, x402 discovery, Explore rank) instead of a bare
 * declared number.
 *
 * No I/O here. Rows come in from the registry mirror / payee table (see
 * db/enrichment-queries.ts) and the orchestrator in karma-resolver.ts decides
 * what survives a failed read. Non-routing mandate: nothing in this module (or
 * its callers) fetches a declared endpoint — strings are sanitized and linked,
 * never followed.
 */

import { AK_METADATA_TAG1, AK_RATER_ADDRESSES } from '@/config/ak-validator';
import {
  METADATA_RUBRIC,
  METADATA_SCHEME_VERSION,
  scoreMetadataQuality,
} from '@/scoring/celo-metadata';
import type { AgentRegistrationFile } from '@/integrations/erc8004-celo';
import type { Chain, ConfidenceBadge } from '@/db/schema';

// --- Caps (response size is bounded by construction) ------------------------

export const ENRICH_MAX_AGENTS = 10;
export const ENRICH_MAX_SERVICES = 10;
export const ENRICH_MAX_RECORDS = 10;
export const ENRICH_MAX_VALIDATORS = 5;
export const ENRICH_MAX_ENDPOINTS = 10;
export const ENRICH_MAX_NOTES = 20;
export const ENRICH_MAX_EXPLAIN = 10;
/** Feedback rows read per call (newest first) — the window distinctClients is computed over. */
export const ENRICH_FEEDBACK_WINDOW = 1000;

const NAME_MAX = 80;
const DESC_MAX = 280;
const URL_MAX = 200;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// --- Input rows (the subset of the mirror columns the builders read) --------

export interface EnrichmentAgentRow {
  chain: Chain | string;
  agent_id: number;
  owner: string;
  agent_wallet: string | null;
  token_uri: string | null;
  registration: unknown | null;
  registration_status: string;
  metadata_score: number | null;
  feedback_count: number | null;
  feedback_avg: string | number | null;
}

export interface EnrichmentFeedbackRow {
  agent_id: number;
  client: string;
  feedback_index: number | null;
  value: string | number | null;
  value_decimals: number | null;
  tag1: string;
  tag2: string;
  revoked: boolean;
  indexed_at: string;
}

export interface EnrichmentPayeeRow {
  chain: Chain | string;
  address: string;
  source_agent_id: number | null;
  endpoint: string | null;
  asset: string | null;
  network: string | null;
  verified: boolean;
  discovered_at: string;
  last_seen_at: string;
}

// --- Output blocks ----------------------------------------------------------

export interface RegistryAgentView {
  agentId: number;
  name: string | null;
  description: string | null;
  registrationStatus: string;
  metadataScore: number;
  feedbackCount: number;
  services: Array<{ name: string; endpoint: string }>;
  explorer: { agentkarma: string; eightthousandfourscan: string | null };
}

export interface RegistryBlock {
  total: number;
  agents: RegistryAgentView[];
}

export interface DeclaredBlock {
  scheme: string;
  version: string;
  agentId: number;
  score: number;
  dimensions: Array<{ key: string; label: string; passed: boolean; points: number; max: number }>;
  notes: string[];
}

export interface FeedbackRecordView {
  agentId: number;
  client: string;
  value: number;
  tag1: string;
  tag2: string;
  revoked: boolean;
  indexedAt: string;
}

export interface FeedbackBlock {
  source: 'registry-mirror';
  count: number;
  average: number | null;
  distinctClients: number;
  sampled: number;
  asOf: string | null;
  records: FeedbackRecordView[];
  validators: Array<{
    agentId: number;
    client: string;
    value: number;
    version: string;
    revoked: boolean;
    indexedAt: string;
  }>;
}

export interface DiscoveryBlock {
  endpoints: Array<{
    endpoint: string | null;
    asset: string | null;
    network: string | null;
    verified: boolean;
    sourceAgentId: number | null;
    lastSeenAt: string;
  }>;
}

export interface KarmaEnrichment {
  registry?: RegistryBlock;
  declared?: DeclaredBlock;
  feedback?: FeedbackBlock;
  discovery?: DiscoveryBlock;
  rankScore: number | null;
  explain: string[];
}

// --- Helpers ----------------------------------------------------------------

/** EVM rows are stored lowercase; Solana base58 / Stellar StrKey are case-sensitive. */
export function normalizeAddressForChain(address: string, chain: Chain | string): string {
  return chain === 'celo' || chain === 'arc' ? address.toLowerCase() : address;
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length === 0 ? null : t.slice(0, max);
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function asRegistration(v: unknown): AgentRegistrationFile | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AgentRegistrationFile) : null;
}

function appOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io';
}

/** Same rule as registryRowToWallet: a never-set agent wallet reads as the zero address. */
function displayAddress(row: EnrichmentAgentRow): string {
  const aw = row.agent_wallet;
  return aw && aw.toLowerCase() !== ZERO_ADDRESS ? aw : row.owner;
}

// --- registry ---------------------------------------------------------------

export function buildRegistryBlock(
  rows: EnrichmentAgentRow[],
  total: number,
  chain: Chain | string,
): RegistryBlock {
  const agents = rows.slice(0, ENRICH_MAX_AGENTS).map((row): RegistryAgentView => {
    const reg = asRegistration(row.registration);
    const services: Array<{ name: string; endpoint: string }> = [];
    if (reg && Array.isArray(reg.services)) {
      for (const s of reg.services) {
        if (services.length >= ENRICH_MAX_SERVICES) break;
        const name = str((s as { name?: unknown })?.name, NAME_MAX);
        const endpoint = str((s as { endpoint?: unknown })?.endpoint, URL_MAX);
        if (name && endpoint) services.push({ name, endpoint });
      }
    }
    const id = Number(row.agent_id);
    return {
      agentId: id,
      name: str(reg?.name, NAME_MAX),
      description: str(reg?.description, DESC_MAX),
      registrationStatus: row.registration_status,
      metadataScore: num(row.metadata_score) ?? 0,
      feedbackCount: num(row.feedback_count) ?? 0,
      services,
      explorer: {
        agentkarma: `${appOrigin()}/agent/${displayAddress(row)}?agentId=${id}&chain=${chain}`,
        eightthousandfourscan: chain === 'celo' ? `https://8004scan.io/agent/${id}` : null,
      },
    };
  });
  return { total, agents };
}

/**
 * The agent the `declared` block scores: the one the wallet row points at
 * (celo_agent_id / arc_agent_id) when it is among the owned rows, else the
 * highest metadata score (rows arrive metadata_score-desc from the query).
 */
export function pickPrimaryAgent(
  rows: EnrichmentAgentRow[],
  walletAgentId: number | null | undefined,
): EnrichmentAgentRow | null {
  if (rows.length === 0) return null;
  if (walletAgentId != null) {
    const hit = rows.find((r) => Number(r.agent_id) === Number(walletAgentId));
    if (hit) return hit;
  }
  return [...rows].sort((a, b) => (num(b.metadata_score) ?? 0) - (num(a.metadata_score) ?? 0))[0];
}

// --- declared ---------------------------------------------------------------

/**
 * Live v0.2 recompute of the metadata rubric on the mirrored registration JSON.
 * `tokenURI` MUST be passed alongside — the tamper-resistance dimension reads
 * it and silently scores 0 without it. The mirror's `metadata_score` column may
 * be an older-rubric figure; this block is the current assessment.
 */
export function buildDeclaredBlock(row: EnrichmentAgentRow | null): DeclaredBlock | null {
  if (!row) return null;
  const registration = asRegistration(row.registration);
  if (!registration) return null;
  const result = scoreMetadataQuality({
    registration,
    tokenURI: row.token_uri ?? undefined,
  });
  return {
    scheme: AK_METADATA_TAG1,
    version: METADATA_SCHEME_VERSION,
    agentId: Number(row.agent_id),
    score: result.score,
    dimensions: METADATA_RUBRIC.map((dim) => {
      const points = result.breakdown[dim.key] ?? 0;
      return { key: dim.key, label: dim.label, passed: points >= dim.max, points, max: dim.max };
    }),
    notes: result.notes.slice(0, ENRICH_MAX_NOTES),
  };
}

// --- feedback ---------------------------------------------------------------

function normalizeValue(row: EnrichmentFeedbackRow): number {
  const raw = num(row.value) ?? 0;
  return raw / 10 ** (row.value_decimals ?? 0);
}

/**
 * count/average come from the mirror's per-agent aggregates (authoritative,
 * non-revoked); distinctClients/records/validators from the newest-first window
 * the caller read (≤ ENRICH_FEEDBACK_WINDOW rows).
 */
export function buildFeedbackBlock(
  agents: EnrichmentAgentRow[],
  rows: EnrichmentFeedbackRow[],
): FeedbackBlock {
  let count = 0;
  let weighted = 0;
  for (const a of agents) {
    const c = num(a.feedback_count) ?? 0;
    const avg = num(a.feedback_avg);
    if (c > 0 && avg != null) {
      count += c;
      weighted += c * avg;
    }
  }
  const average = count > 0 ? weighted / count : null;

  const sorted = [...rows].sort((a, b) => (a.indexed_at < b.indexed_at ? 1 : a.indexed_at > b.indexed_at ? -1 : 0));
  const clients = new Set(sorted.map((r) => r.client.toLowerCase()));
  const akRaters = new Set(AK_RATER_ADDRESSES);

  const records = sorted.slice(0, ENRICH_MAX_RECORDS).map((r): FeedbackRecordView => ({
    agentId: Number(r.agent_id),
    client: r.client,
    value: normalizeValue(r),
    tag1: r.tag1,
    tag2: r.tag2,
    revoked: r.revoked,
    indexedAt: r.indexed_at,
  }));

  const validators = sorted
    .filter((r) => r.tag1 === AK_METADATA_TAG1 && akRaters.has(r.client.toLowerCase()))
    .slice(0, ENRICH_MAX_VALIDATORS)
    .map((r) => ({
      agentId: Number(r.agent_id),
      client: r.client,
      value: normalizeValue(r),
      version: r.tag2,
      revoked: r.revoked,
      indexedAt: r.indexed_at,
    }));

  return {
    source: 'registry-mirror',
    count,
    average,
    distinctClients: clients.size,
    sampled: rows.length,
    asOf: sorted[0]?.indexed_at ?? null,
    records,
    validators,
  };
}

// --- discovery --------------------------------------------------------------

export function buildDiscoveryBlock(rows: EnrichmentPayeeRow[]): DiscoveryBlock {
  return {
    endpoints: rows.slice(0, ENRICH_MAX_ENDPOINTS).map((r) => ({
      endpoint: str(r.endpoint, URL_MAX),
      asset: r.asset,
      network: r.network,
      verified: r.verified,
      sourceAgentId: r.source_agent_id != null ? Number(r.source_agent_id) : null,
      lastSeenAt: r.last_seen_at,
    })),
  };
}

// --- explain ----------------------------------------------------------------

export interface ExplainInput {
  chain: Chain | string;
  provider: { score: number; trustTier: string; confidenceBadge: ConfidenceBadge | string };
  consumerHasSignal: boolean;
  txCount: number;
  claimed: boolean;
  rankScore: number | null;
  /** undefined = read failed (say nothing); null = read succeeded, nothing owned. */
  registry?: RegistryBlock | null;
  declared?: DeclaredBlock | null;
  feedback?: FeedbackBlock | null;
  discovery?: DiscoveryBlock | null;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const fmt1 = (n: number) => (Math.round(n * 10) / 10).toString();

/**
 * Plain, factual sentences derived only from the data. Deterministic: no LLM,
 * no clock, no randomness. Ordered provider → identity → registry → declared →
 * feedback → discovery → rank → consumer. Capped at ENRICH_MAX_EXPLAIN lines.
 */
export function buildExplain(input: ExplainInput): string[] {
  const out: string[] = [];
  const { provider, txCount } = input;
  const declaredOnly = provider.confidenceBadge === 'declared' && txCount === 0;

  out.push(
    declaredOnly
      ? `Provider score ${provider.score} (${provider.trustTier}), declared; no payment receipts on record, so the score comes from declared metadata only.`
      : `Provider score ${provider.score} (${provider.trustTier}), ${provider.confidenceBadge}, from ${txCount} indexed ${plural(txCount, 'transaction', 'transactions')}.`,
  );
  out.push(input.claimed ? 'Claimed by its operator.' : 'Unclaimed by its operator.');

  if (input.registry === null) {
    out.push(`No ERC-8004 registry identity found for this address on ${input.chain}.`);
  } else if (input.registry && input.registry.total > 0) {
    const name = input.registry.agents[0]?.name;
    const n = input.registry.total;
    if (n === 1) out.push(`Owns 1 ERC-8004 agent on ${input.chain}${name ? `: "${name}"` : ''}.`);
    else out.push(`Owns ${n} ERC-8004 agents on ${input.chain}${name ? `, including "${name}"` : ''}.`);
  }

  if (input.declared) {
    const d = input.declared;
    const passed = d.dimensions.filter((x) => x.passed).length;
    out.push(
      `Declared metadata scores ${d.score}/100 (${passed}/${d.dimensions.length} rubric checks passed, scheme ${d.scheme} ${d.version}).`,
    );
  }

  if (input.feedback) {
    const f = input.feedback;
    if (f.count > 0) {
      out.push(
        `${f.count} ERC-8004 feedback ${plural(f.count, 'record', 'records')} from ${f.distinctClients} distinct ${plural(f.distinctClients, 'client', 'clients')} (sampled ${f.sampled})${f.average != null ? `, average ${fmt1(f.average)}` : ''}.`,
      );
      const v = f.validators.length;
      if (v > 0) {
        out.push(
          v === 1
            ? "1 of these is AK's own metadata attestation."
            : `${v} of these are AK's own metadata attestations.`,
        );
      }
    } else {
      out.push('No ERC-8004 feedback records on the registry mirror.');
    }
  }

  if (input.discovery && input.discovery.endpoints.length > 0) {
    const eps = input.discovery.endpoints;
    const verified = eps.filter((e) => e.verified).length;
    if (verified > 0) {
      out.push(
        `${eps.length} x402 ${plural(eps.length, 'endpoint', 'endpoints')} discovered for this address, ${verified} verified.`,
      );
    } else {
      out.push(
        `${eps.length} unverified x402 payee ${plural(eps.length, 'declaration points', 'declarations point')} at this address from another agent (not attributed to this wallet).`,
      );
    }
  }

  if (input.rankScore != null && provider.confidenceBadge === 'declared') {
    out.push(`Ranks on Explore at ${fmt1(input.rankScore)} (declared evidence is weighted ×0.7).`);
  }

  if (!input.consumerHasSignal) out.push('No consumer (payment-behavior) signal.');

  return out.slice(0, ENRICH_MAX_EXPLAIN);
}
