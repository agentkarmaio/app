/**
 * Karma DB Schema
 *
 * Drizzle table definitions -> used by drizzle-kit for schema push/migrations
 * TypeScript types -> used at runtime by Supabase client queries
 */

import {
  pgTable, text, timestamp, integer, numeric, boolean, uuid, index, uniqueIndex, jsonb,
  primaryKey, foreignKey,
} from 'drizzle-orm/pg-core';

// ─── Chain dimension ─────────────────────────────────────────────────────────
//
// Every agent identity is keyed by (chain, address). Adding a chain extends
// this union and feeds the composite primary key on `wallets` plus every
// foreign key that references it. NEVER reuse a value across chains —
// addresses are format-disjoint today (Solana base58 vs EVM 0x40hex) but the
// composite PK is the durable correctness guarantee.

export const CHAINS = ['solana', 'celo', 'stellar'] as const;
export type Chain = (typeof CHAINS)[number];
export const DEFAULT_CHAIN: Chain = 'solana';

export function isChain(value: unknown): value is Chain {
  return typeof value === 'string' && (CHAINS as readonly string[]).includes(value);
}

// --- Drizzle Table Definitions (for drizzle-kit push) -------------------------

export const walletsTable = pgTable('wallets', {
  chain:           text('chain').notNull().default('solana').$type<Chain>(),
  address:         text('address').notNull(),
  first_seen:      timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
  last_seen:       timestamp('last_seen',  { withTimezone: true }).notNull().defaultNow(),
  tx_count:        integer('tx_count').notNull().default(0),
  score:           numeric('score', { precision: 6, scale: 2 }).notNull().default('0'),
  trust_tier:      text('trust_tier').notNull().default('Unrated'),
  updated_at:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  entity_name:     text('entity_name'),
  entity_category: text('entity_category'),
  funded_by:       text('funded_by'),
  funded_by_name:  text('funded_by_name'),
  sybil_risk:      boolean('sybil_risk').default(false),
  enriched_at:     timestamp('enriched_at', { withTimezone: true }),
  // Agent claiming (optional identity enrichment)
  claimed:         boolean('claimed').default(false),
  display_name:    text('display_name'),
  description:     text('description'),
  website:         text('website'),
  category:        text('category'),
  claimed_at:      timestamp('claimed_at', { withTimezone: true }),
  // Tier 3 declared identity: parallel agent-payment rail addresses. MPP runs
  // on Tempo (EVM-style 0x… 42-char). Declared-only — no on-chain verification
  // until cross-chain wallet linkage lands. NEVER blended into Karma.
  tempo_address:   text('tempo_address'),
  // Two-faced karma (Phase F — signal spectrum)
  provider_score:  numeric('provider_score', { precision: 6, scale: 2 }).notNull().default('0'),
  consumer_score:  numeric('consumer_score', { precision: 6, scale: 2 }),
  confidence_badge: text('confidence_badge').notNull().default('declared'),
  // Autonomy Confidence (RFC v0.3 §5.5) — orthogonal to karma
  autonomy_score:  numeric('autonomy_score', { precision: 6, scale: 2 }),
  autonomy_label:  text('autonomy_label'),
  // Denormalized Tier-2 metric values (0–1) so the Explore table can filter
  // + sort on them without joining scores/signal_events for every query.
  metric_success_rate: numeric('metric_success_rate', { precision: 5, scale: 4 }),
  metric_diversity:    numeric('metric_diversity',    { precision: 5, scale: 4 }),
  metric_volume:       numeric('metric_volume',       { precision: 5, scale: 4 }),
  metric_age:          numeric('metric_age',          { precision: 5, scale: 4 }),
  metric_cadence:      numeric('metric_cadence',      { precision: 5, scale: 4 }),
  // Deferred-scoring queue: set by the webhook/indexer when new txs land,
  // cleared by the rescore worker after scores are recomputed. Keeps the
  // webhook hot path O(batch-size) instead of O(wallet-history).
  scoring_dirty_at:    timestamp('scoring_dirty_at', { withTimezone: true }),
  // Wallet-side regressive scan queue. NULL = never scanned. State machine:
  // pending → scanning → done | failed. Drives the worker drain in
  // instrumentation.ts (mirrors scoring_dirty_at pattern).
  scan_state:          text('scan_state'),
  scan_requested_at:   timestamp('scan_requested_at',   { withTimezone: true }),
  scan_completed_at:   timestamp('scan_completed_at',   { withTimezone: true }),
  scan_attempts:       integer('scan_attempts').notNull().default(0),
  scan_hit_count:      integer('scan_hit_count').notNull().default(0),
  scan_partial:        boolean('scan_partial').notNull().default(false),
  scan_last_error:     text('scan_last_error'),
  // Self Protocol attestation (Tier 3 declared — see RFC §5.5). Filled by the
  // /api/v2/self/verify endpoint when a wallet's controlling human completes
  // a passport scan via the Self mobile app. self_nullifier is the unique
  // per-(user, scope) marker from the ZK proof — proof-of-presence, not the
  // passport data itself.
  // UNIQUE on (self_nullifier) — one passport (per scope) anchors one wallet.
  // Doubles as the replay guard since the SDK is stateless.
  self_nullifier:      text('self_nullifier').unique(),
  self_verified_at:    timestamp('self_verified_at', { withTimezone: true }),
  self_scope:          text('self_scope'),
}, (table) => [
  primaryKey({ columns: [table.chain, table.address], name: 'wallets_pkey' }),
  index('idx_wallets_chain').on(table.chain),
  index('idx_wallets_address').on(table.address),
  index('idx_wallets_score').on(table.score),
  index('idx_wallets_provider_score').on(table.provider_score),
  index('idx_wallets_confidence_badge').on(table.confidence_badge),
  index('idx_wallets_autonomy_score').on(table.autonomy_score),
  index('idx_wallets_metric_cadence').on(table.metric_cadence),
  index('idx_wallets_metric_success_rate').on(table.metric_success_rate),
  index('idx_wallets_metric_diversity').on(table.metric_diversity),
  index('idx_wallets_scoring_dirty_at').on(table.scoring_dirty_at),
  index('idx_wallets_scan_state').on(table.scan_state),
]);

export const transactionsTable = pgTable('transactions', {
  id:             uuid('id').primaryKey().defaultRandom(),
  chain:          text('chain').notNull().default('solana').$type<Chain>(),
  wallet_address: text('wallet_address').notNull(),
  facilitator:    text('facilitator').notNull(),
  amount:         numeric('amount', { precision: 20, scale: 6 }).notNull().default('0'),
  timestamp:      timestamp('timestamp', { withTimezone: true }).notNull(),
  success:        boolean('success').notNull().default(true),
  tx_signature:   text('tx_signature').unique().notNull(),
}, (table) => [
  foreignKey({
    columns: [table.chain, table.wallet_address],
    foreignColumns: [walletsTable.chain, walletsTable.address],
    name: 'transactions_chain_wallet_address_fkey',
  }).onDelete('cascade'),
  index('idx_transactions_chain_wallet_address').on(table.chain, table.wallet_address),
  index('idx_transactions_facilitator').on(table.facilitator),
  index('idx_transactions_timestamp').on(table.timestamp),
]);

export const scoresTable = pgTable('scores', {
  id:             uuid('id').primaryKey().defaultRandom(),
  chain:          text('chain').notNull().default('solana').$type<Chain>(),
  wallet_address: text('wallet_address').notNull(),
  score:          numeric('score', { precision: 6, scale: 2 }).notNull(),
  success_rate:   numeric('success_rate', { precision: 5, scale: 4 }).notNull().default('0'),
  diversity:      numeric('diversity', { precision: 5, scale: 4 }).notNull().default('0'),
  volume:         numeric('volume', { precision: 20, scale: 6 }).notNull().default('0'),
  age:            integer('age').notNull().default(0),
  calculated_at:  timestamp('calculated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.chain, table.wallet_address],
    foreignColumns: [walletsTable.chain, walletsTable.address],
    name: 'scores_chain_wallet_address_fkey',
  }).onDelete('cascade'),
  index('idx_scores_chain_wallet_address').on(table.chain, table.wallet_address),
  index('idx_scores_calculated_at').on(table.calculated_at),
]);

// --- Consumer Feedback -------------------------------------------------------

export const feedbackTable = pgTable('feedback', {
  id:              uuid('id').primaryKey().defaultRandom(),
  chain:           text('chain').notNull().default('solana').$type<Chain>(),
  agent_wallet:    text('agent_wallet').notNull(),
  consumer_wallet: text('consumer_wallet').notNull(),
  rating:          text('rating').notNull(),  // 'delivered' | 'failed'
  tx_signature:    text('tx_signature').notNull().unique(), // one feedback per tx
  created_at:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.chain, table.agent_wallet],
    foreignColumns: [walletsTable.chain, walletsTable.address],
    name: 'feedback_chain_agent_wallet_fkey',
  }).onDelete('cascade'),
  index('idx_feedback_chain_agent_wallet').on(table.chain, table.agent_wallet),
  index('idx_feedback_tx_signature').on(table.tx_signature),
]);

// --- Signal Events (Phase F — signal spectrum) -------------------------------

export const signalEventsTable = pgTable('signal_events', {
  id:           uuid('id').primaryKey().defaultRandom(),
  chain:        text('chain').notNull().default('solana').$type<Chain>(),
  agent_wallet: text('agent_wallet').notNull(),
  tier:         integer('tier').notNull(),
  kind:         text('kind').notNull(),
  face:         text('face').notNull().default('provider'),
  weight:       numeric('weight', { precision: 5, scale: 4 }).notNull().default('1.0'),
  value:        numeric('value', { precision: 5, scale: 4 }),
  payload:      jsonb('payload'),
  signed_by:    text('signed_by'),
  tx_ref:       text('tx_ref'),
  observed_at:  timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  created_at:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.chain, table.agent_wallet],
    foreignColumns: [walletsTable.chain, walletsTable.address],
    name: 'signal_events_chain_agent_wallet_fkey',
  }).onDelete('cascade'),
  index('idx_signal_events_chain_agent_wallet').on(table.chain, table.agent_wallet),
  index('idx_signal_events_tier').on(table.tier),
  index('idx_signal_events_face').on(table.face),
  index('idx_signal_events_observed_at').on(table.observed_at),
  index('idx_signal_events_kind').on(table.kind),
  // Dedup same external event across retries. Rows with NULL tx_ref (synthetic
  // signals) don't collide because Postgres treats NULLs as distinct in unique
  // indexes — same effect as a partial index but Supabase-js `.upsert()` needs
  // a non-partial target to match ON CONFLICT. Now chain-scoped.
  uniqueIndex('uniq_signal_events_dedup')
    .on(table.chain, table.agent_wallet, table.kind, table.tx_ref),
]);

// --- Organizations (Enterprise fleet view) ----------------------------------

export const organizationsTable = pgTable('organizations', {
  slug:        text('slug').primaryKey(),
  name:        text('name').notNull(),
  description: text('description'),
  website:     text('website'),
  logo_url:    text('logo_url'),
  verified:    boolean('verified').notNull().default(false),
  created_at:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const organizationMembersTable = pgTable('organization_members', {
  id:               uuid('id').primaryKey().defaultRandom(),
  organization_slug: text('organization_slug').notNull().references(() => organizationsTable.slug, { onDelete: 'cascade' }),
  chain:            text('chain').notNull().default('solana').$type<Chain>(),
  agent_wallet:     text('agent_wallet').notNull(),
  role:             text('role'),
  added_at:         timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.chain, table.agent_wallet],
    foreignColumns: [walletsTable.chain, walletsTable.address],
    name: 'organization_members_chain_agent_wallet_fkey',
  }).onDelete('cascade'),
  index('idx_org_members_slug').on(table.organization_slug),
  index('idx_org_members_chain_wallet').on(table.chain, table.agent_wallet),
  uniqueIndex('uniq_org_members').on(table.organization_slug, table.chain, table.agent_wallet),
]);

// --- Agent Manifests (Phase H1 — Tier 3 declared identity) ------------------

export const agentManifestsTable = pgTable('agent_manifests', {
  id:           uuid('id').primaryKey().defaultRandom(),
  chain:        text('chain').notNull().default('solana').$type<Chain>(),
  agent_wallet: text('agent_wallet').notNull(),
  source_type:  text('source_type').notNull(), // 'x402_accepts' | 'mcp_descriptor' | 'self_hosted' | 'claim_form'
  url:          text('url'),
  fetched_at:   timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  raw:          jsonb('raw'),
  parsed:       jsonb('parsed'),
  verified:     boolean('verified').notNull().default(false),
  created_at:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.chain, table.agent_wallet],
    foreignColumns: [walletsTable.chain, walletsTable.address],
    name: 'agent_manifests_chain_agent_wallet_fkey',
  }).onDelete('cascade'),
  index('idx_agent_manifests_chain_agent_wallet').on(table.chain, table.agent_wallet),
  index('idx_agent_manifests_source_type').on(table.source_type),
  // One manifest row per (chain, wallet, source_type) — resolver overwrites on refresh.
  uniqueIndex('uniq_agent_manifests_source').on(table.chain, table.agent_wallet, table.source_type),
]);

// --- Deck Views (pitch-deck visitor identification) -------------------------
//
// Captured when a visitor submits the email gate at /deck (and on every
// returning-visitor load). Used both for OpenReplay correlation and lead
// follow-up. Not joined to wallets — these are humans, not agents.

export const deckViewsTable = pgTable('deck_views', {
  id:           uuid('id').primaryKey().defaultRandom(),
  email:        text('email').notNull(),
  is_returning: boolean('is_returning').notNull().default(false),
  ip:           text('ip'),
  user_agent:   text('user_agent'),
  referrer:     text('referrer'),
  created_at:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_deck_views_email').on(table.email),
  index('idx_deck_views_created_at').on(table.created_at),
]);

// --- Indexer Cursor State ----------------------------------------------------

export const indexerCursorsTable = pgTable('indexer_cursors', {
  chain:          text('chain').notNull().default('solana').$type<Chain>(),
  facilitator:    text('facilitator').notNull(),
  last_signature: text('last_signature').notNull(),
  last_slot:      integer('last_slot'),
  updated_at:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.chain, table.facilitator], name: 'indexer_cursors_pkey' }),
  index('idx_indexer_cursors_chain').on(table.chain),
]);

// --- TypeScript Types (for runtime Supabase queries) -------------------------

export type TrustTier = 'Unrated' | 'Poor' | 'Fair' | 'Good' | 'Very Good' | 'Excellent';

export type LivenessStatus = 'Active' | 'Recent' | 'Dormant' | 'Inactive';

export type AgentCategory = 'ai' | 'data' | 'defi' | 'infra' | 'social' | 'utility' | 'other';

export type ConfidenceBadge = 'receipt-backed' | 'behavior-inferred' | 'declared';
export type SignalTier = 1 | 2 | 3 | 4;
export type KarmaFace = 'provider' | 'consumer';

export interface Wallet {
  chain: Chain;
  address: string;
  first_seen: string;
  last_seen: string;
  tx_count: number;
  score: number;
  trust_tier: TrustTier;
  updated_at: string;
  entity_name?: string | null;
  entity_category?: string | null;
  funded_by?: string | null;
  funded_by_name?: string | null;
  sybil_risk?: boolean;
  enriched_at?: string | null;
  // Agent claiming
  claimed?: boolean;
  display_name?: string | null;
  description?: string | null;
  website?: string | null;
  category?: string | null;
  claimed_at?: string | null;
  // Tier 3 declared identity (parallel agent-payment rails). Tempo / MPP.
  tempo_address?: string | null;
  // Two-faced karma (Phase F)
  provider_score: number;
  consumer_score: number | null;
  confidence_badge: ConfidenceBadge;
  autonomy_score?: number | null;
  autonomy_label?: AutonomyLabel | null;
  // Denormalized Tier-2 metrics (0–1, nullable until first score recompute)
  metric_success_rate?: number | null;
  metric_diversity?: number | null;
  metric_volume?: number | null;
  metric_age?: number | null;
  metric_cadence?: number | null;
  // Deferred-scoring queue sentinel. Non-null = awaiting recompute.
  scoring_dirty_at?: string | null;
  // Wallet-side regressive scan queue (Phase H+ — backfill on lookup).
  scan_state?: WalletScanState | null;
  scan_requested_at?: string | null;
  scan_completed_at?: string | null;
  scan_attempts?: number;
  scan_hit_count?: number;
  scan_partial?: boolean;
  scan_last_error?: string | null;
  // Self Protocol attestation
  self_nullifier?: string | null;
  self_verified_at?: string | null;
  self_scope?: string | null;
}

export type WalletScanState = 'pending' | 'scanning' | 'done' | 'failed';

export type AutonomyLabel = 'agent-like' | 'mixed' | 'human-like';

export interface Organization {
  slug: string;
  name: string;
  description: string | null;
  website: string | null;
  logo_url: string | null;
  verified: boolean;
  created_at: string;
}

export interface OrganizationMember {
  id: string;
  organization_slug: string;
  chain: Chain;
  agent_wallet: string;
  role: string | null;
  added_at: string;
}

export type ManifestSourceType = 'x402_accepts' | 'mcp_descriptor' | 'self_hosted' | 'claim_form';

export interface AgentManifest {
  id: string;
  chain: Chain;
  agent_wallet: string;
  source_type: ManifestSourceType;
  url: string | null;
  fetched_at: string;
  raw: Record<string, unknown> | null;
  parsed: ParsedManifest | null;
  verified: boolean;
  created_at: string;
}

/** Normalized view of what a manifest declares, regardless of source format. */
export interface ParsedManifest {
  name?: string | null;
  description?: string | null;
  website?: string | null;
  github?: string | null;
  category?: string | null;
  capabilities?: string[];
  endpoints?: Array<{ kind: string; url: string; description?: string }>;
  /** Optional Tempo (EVM 0x…) address — declares MPP rail participation. */
  tempoAddress?: string | null;
  [key: string]: unknown;
}

/**
 * EVM-style address (Tempo, used by MPP). Matched case-insensitively; we store
 * whatever the user typed (no normalization) so checksummed addresses survive.
 */
export const TEMPO_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
export function isTempoAddress(value: unknown): value is string {
  return typeof value === 'string' && TEMPO_ADDRESS_REGEX.test(value);
}

export interface SignalEvent {
  id: string;
  chain: Chain;
  agent_wallet: string;
  tier: SignalTier;
  kind: string;
  face: KarmaFace;
  weight: number;
  value: number | null;
  payload: Record<string, unknown> | null;
  signed_by: string | null;
  tx_ref: string | null;
  observed_at: string;
  created_at: string;
}

/** Derive liveness status from last_seen timestamp */
export function getLivenessStatus(lastSeen: string | Date): LivenessStatus {
  const ms = Date.now() - new Date(lastSeen).getTime();
  const hours = ms / (1000 * 60 * 60);
  if (hours <= 24) return 'Active';
  if (hours <= 7 * 24) return 'Recent';
  if (hours <= 90 * 24) return 'Dormant';
  return 'Inactive';
}

export interface Transaction {
  id: string;
  chain: Chain;
  wallet_address: string;
  facilitator: string;
  amount: number;
  timestamp: string;
  success: boolean;
  tx_signature: string;
}

export interface Score {
  id: string;
  chain: Chain;
  wallet_address: string;
  score: number;
  success_rate: number;
  diversity: number;
  volume: number;
  age: number;
  calculated_at: string;
}

export type FeedbackRating = 'delivered' | 'failed';

export interface Feedback {
  id: string;
  chain: Chain;
  agent_wallet: string;
  consumer_wallet: string;
  rating: FeedbackRating;
  tx_signature: string;
  created_at: string;
}

export interface IndexerCursor {
  chain: Chain;
  facilitator: string;
  last_signature: string;
  last_slot: number | null;
  updated_at: string;
}
