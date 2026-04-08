/**
 * Karma DB Schema
 *
 * Drizzle table definitions -> used by drizzle-kit for schema push/migrations
 * TypeScript types -> used at runtime by Supabase client queries
 */

import {
  pgTable, text, timestamp, integer, numeric, boolean, uuid, index,
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
}, (table) => [
  index('idx_wallets_score').on(table.score),
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
