/**
 * Karma DB Schema
 *
 * Drizzle table definitions -> used by drizzle-kit for schema push/migrations
 * TypeScript types -> used at runtime by Supabase client queries
 */

import {
  pgTable, text, timestamp, integer, numeric, boolean, uuid, index, uniqueIndex, jsonb,
} from 'drizzle-orm/pg-core';

// --- Drizzle Table Definitions (for drizzle-kit push) -------------------------

export const walletsTable = pgTable('wallets', {
  address:         text('address').primaryKey(),
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
  // Two-faced karma (Phase F — signal spectrum)
  provider_score:  numeric('provider_score', { precision: 6, scale: 2 }).notNull().default('0'),
  consumer_score:  numeric('consumer_score', { precision: 6, scale: 2 }),
  confidence_badge: text('confidence_badge').notNull().default('declared'),
  // Autonomy Confidence (RFC v0.3 §5.5) — orthogonal to karma
  autonomy_score:  numeric('autonomy_score', { precision: 6, scale: 2 }),
  autonomy_label:  text('autonomy_label'),
}, (table) => [
  index('idx_wallets_score').on(table.score),
  index('idx_wallets_provider_score').on(table.provider_score),
  index('idx_wallets_confidence_badge').on(table.confidence_badge),
  index('idx_wallets_autonomy_score').on(table.autonomy_score),
]);

export const transactionsTable = pgTable('transactions', {
  id:             uuid('id').primaryKey().defaultRandom(),
  wallet_address: text('wallet_address').notNull().references(() => walletsTable.address, { onDelete: 'cascade' }),
  facilitator:    text('facilitator').notNull(),
  amount:         numeric('amount', { precision: 20, scale: 6 }).notNull().default('0'),
  timestamp:      timestamp('timestamp', { withTimezone: true }).notNull(),
  success:        boolean('success').notNull().default(true),
  tx_signature:   text('tx_signature').unique().notNull(),
}, (table) => [
  index('idx_transactions_wallet_address').on(table.wallet_address),
  index('idx_transactions_facilitator').on(table.facilitator),
  index('idx_transactions_timestamp').on(table.timestamp),
]);

export const scoresTable = pgTable('scores', {
  id:             uuid('id').primaryKey().defaultRandom(),
  wallet_address: text('wallet_address').notNull().references(() => walletsTable.address, { onDelete: 'cascade' }),
  score:          numeric('score', { precision: 6, scale: 2 }).notNull(),
  success_rate:   numeric('success_rate', { precision: 5, scale: 4 }).notNull().default('0'),
  diversity:      numeric('diversity', { precision: 5, scale: 4 }).notNull().default('0'),
  volume:         numeric('volume', { precision: 20, scale: 6 }).notNull().default('0'),
  age:            integer('age').notNull().default(0),
  calculated_at:  timestamp('calculated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_scores_wallet_address').on(table.wallet_address),
  index('idx_scores_calculated_at').on(table.calculated_at),
]);

// --- Consumer Feedback -------------------------------------------------------

export const feedbackTable = pgTable('feedback', {
  id:              uuid('id').primaryKey().defaultRandom(),
  agent_wallet:    text('agent_wallet').notNull().references(() => walletsTable.address, { onDelete: 'cascade' }),
  consumer_wallet: text('consumer_wallet').notNull(),
  rating:          text('rating').notNull(),  // 'delivered' | 'failed'
  tx_signature:    text('tx_signature').notNull().unique(), // one feedback per tx
  created_at:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_feedback_agent_wallet').on(table.agent_wallet),
  index('idx_feedback_tx_signature').on(table.tx_signature),
]);

// --- Signal Events (Phase F — signal spectrum) -------------------------------

export const signalEventsTable = pgTable('signal_events', {
  id:           uuid('id').primaryKey().defaultRandom(),
  agent_wallet: text('agent_wallet').notNull().references(() => walletsTable.address, { onDelete: 'cascade' }),
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
  index('idx_signal_events_agent_wallet').on(table.agent_wallet),
  index('idx_signal_events_tier').on(table.tier),
  index('idx_signal_events_face').on(table.face),
  index('idx_signal_events_observed_at').on(table.observed_at),
  index('idx_signal_events_kind').on(table.kind),
  // Dedup same external event across retries. Rows with NULL tx_ref (synthetic
  // signals) don't collide because Postgres treats NULLs as distinct in unique
  // indexes — same effect as a partial index but Supabase-js `.upsert()` needs
  // a non-partial target to match ON CONFLICT.
  uniqueIndex('uniq_signal_events_dedup')
    .on(table.agent_wallet, table.kind, table.tx_ref),
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
  agent_wallet:     text('agent_wallet').notNull().references(() => walletsTable.address, { onDelete: 'cascade' }),
  role:             text('role'),
  added_at:         timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_org_members_slug').on(table.organization_slug),
  index('idx_org_members_wallet').on(table.agent_wallet),
  uniqueIndex('uniq_org_members').on(table.organization_slug, table.agent_wallet),
]);

// --- Agent Manifests (Phase H1 — Tier 3 declared identity) ------------------

export const agentManifestsTable = pgTable('agent_manifests', {
  id:           uuid('id').primaryKey().defaultRandom(),
  agent_wallet: text('agent_wallet').notNull().references(() => walletsTable.address, { onDelete: 'cascade' }),
  source_type:  text('source_type').notNull(), // 'x402_accepts' | 'mcp_descriptor' | 'self_hosted' | 'claim_form'
  url:          text('url'),
  fetched_at:   timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  raw:          jsonb('raw'),
  parsed:       jsonb('parsed'),
  verified:     boolean('verified').notNull().default(false),
  created_at:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_agent_manifests_agent_wallet').on(table.agent_wallet),
  index('idx_agent_manifests_source_type').on(table.source_type),
  // One manifest row per (wallet, source_type) — resolver overwrites on refresh.
  uniqueIndex('uniq_agent_manifests_source').on(table.agent_wallet, table.source_type),
]);

// --- Indexer Cursor State ----------------------------------------------------

export const indexerCursorsTable = pgTable('indexer_cursors', {
  facilitator:    text('facilitator').primaryKey(),
  last_signature: text('last_signature').notNull(),
  last_slot:      integer('last_slot'),
  updated_at:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// --- TypeScript Types (for runtime Supabase queries) -------------------------

export type TrustTier = 'Unrated' | 'Poor' | 'Fair' | 'Good' | 'Very Good' | 'Excellent';

export type LivenessStatus = 'Active' | 'Recent' | 'Dormant' | 'Inactive';

export type AgentCategory = 'ai' | 'data' | 'defi' | 'infra' | 'social' | 'utility' | 'other';

export type ConfidenceBadge = 'receipt-backed' | 'behavior-inferred' | 'declared';
export type SignalTier = 1 | 2 | 3 | 4;
export type KarmaFace = 'provider' | 'consumer';

export interface Wallet {
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
  // Two-faced karma (Phase F)
  provider_score: number;
  consumer_score: number | null;
  confidence_badge: ConfidenceBadge;
  autonomy_score?: number | null;
  autonomy_label?: AutonomyLabel | null;
}

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
  agent_wallet: string;
  role: string | null;
  added_at: string;
}

export type ManifestSourceType = 'x402_accepts' | 'mcp_descriptor' | 'self_hosted' | 'claim_form';

export interface AgentManifest {
  id: string;
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
  [key: string]: unknown;
}

export interface SignalEvent {
  id: string;
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
  wallet_address: string;
  facilitator: string;
  amount: number;
  timestamp: string;
  success: boolean;
  tx_signature: string;
}

export interface Score {
  id: string;
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
  agent_wallet: string;
  consumer_wallet: string;
  rating: FeedbackRating;
  tx_signature: string;
  created_at: string;
}

export interface IndexerCursor {
  facilitator: string;
  last_signature: string;
  last_slot: number | null;
  updated_at: string;
}
