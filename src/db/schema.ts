/**
 * Karma DB Schema
 *
 * Drizzle table definitions → used by drizzle-kit for schema push/migrations
 * TypeScript types → used at runtime by Supabase client queries
 */

import {
  pgTable, text, timestamp, integer, numeric, boolean, uuid,
} from 'drizzle-orm/pg-core';

// ─── Drizzle Table Definitions (for drizzle-kit push) ────────────────────────

export const walletsTable = pgTable('wallets', {
  address:    text('address').primaryKey(),
  first_seen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
  last_seen:  timestamp('last_seen',  { withTimezone: true }).notNull().defaultNow(),
  tx_count:   integer('tx_count').notNull().default(0),
  score:      numeric('score', { precision: 6, scale: 2 }).notNull().default('0'),
  trust_tier: text('trust_tier').notNull().default('Unrated'),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const transactionsTable = pgTable('transactions', {
  id:             uuid('id').primaryKey().defaultRandom(),
  wallet_address: text('wallet_address').notNull().references(() => walletsTable.address, { onDelete: 'cascade' }),
  facilitator:    text('facilitator').notNull(),
  amount:         numeric('amount', { precision: 20, scale: 6 }).notNull().default('0'),
  timestamp:      timestamp('timestamp', { withTimezone: true }).notNull(),
  success:        boolean('success').notNull().default(true),
  tx_signature:   text('tx_signature').unique().notNull(),
});

export const scoresTable = pgTable('scores', {
  id:             uuid('id').primaryKey().defaultRandom(),
  wallet_address: text('wallet_address').notNull().references(() => walletsTable.address, { onDelete: 'cascade' }),
  score:          numeric('score', { precision: 6, scale: 2 }).notNull(),
  success_rate:   numeric('success_rate', { precision: 5, scale: 4 }).notNull().default('0'),
  diversity:      numeric('diversity', { precision: 5, scale: 4 }).notNull().default('0'),
  volume:         numeric('volume', { precision: 20, scale: 6 }).notNull().default('0'),
  age:            integer('age').notNull().default(0),
  calculated_at:  timestamp('calculated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── TypeScript Types (for runtime Supabase queries) ─────────────────────────

export type TrustTier = 'Unrated' | 'Poor' | 'Fair' | 'Good' | 'Very Good' | 'Excellent';

export interface Wallet {
  address: string;
  first_seen: string;
  last_seen: string;
  tx_count: number;
  score: number;
  trust_tier: TrustTier;
  updated_at: string;
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
