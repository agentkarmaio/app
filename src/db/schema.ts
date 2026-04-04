/**
 * Karma DB Schema — Supabase Postgres
 * Uses Drizzle ORM style types + plain SQL migrations
 */

// ─── Raw SQL for Supabase migrations ──────────────────────────────────────────

export const SQL_SCHEMA = /* sql */ `
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- wallets: one row per tracked agent wallet
CREATE TABLE IF NOT EXISTS wallets (
  address       TEXT        PRIMARY KEY,         -- Solana wallet pubkey
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tx_count      INTEGER     NOT NULL DEFAULT 0,
  score         NUMERIC(6,2) NOT NULL DEFAULT 0, -- composite karma score (0-100)
  trust_tier    TEXT        NOT NULL DEFAULT 'unknown'
                              CHECK (trust_tier IN ('unknown','low','medium','high','trusted')),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- transactions: every observed x402 payment
CREATE TABLE IF NOT EXISTS transactions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address  TEXT        NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
  facilitator     TEXT        NOT NULL,           -- facilitator address (e.g. DEXTER)
  amount          NUMERIC(20,6) NOT NULL DEFAULT 0, -- USDC amount
  timestamp       TIMESTAMPTZ NOT NULL,
  success         BOOLEAN     NOT NULL DEFAULT TRUE,
  tx_signature    TEXT        UNIQUE NOT NULL     -- Solana tx signature
);

CREATE INDEX IF NOT EXISTS idx_transactions_wallet     ON transactions(wallet_address);
CREATE INDEX IF NOT EXISTS idx_transactions_facilitator ON transactions(facilitator);
CREATE INDEX IF NOT EXISTS idx_transactions_timestamp  ON transactions(timestamp DESC);

-- scores: historical scoring snapshots for trend analysis
CREATE TABLE IF NOT EXISTS scores (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address  TEXT        NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
  score           NUMERIC(6,2) NOT NULL,          -- overall score (0-100)
  success_rate    NUMERIC(5,4) NOT NULL DEFAULT 0, -- 0.0–1.0
  diversity       NUMERIC(5,4) NOT NULL DEFAULT 0, -- facilitator diversity index (0-1)
  volume          NUMERIC(20,6) NOT NULL DEFAULT 0, -- total USDC volume
  age             INTEGER     NOT NULL DEFAULT 0, -- days since first seen
  calculated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scores_wallet       ON scores(wallet_address);
CREATE INDEX IF NOT EXISTS idx_scores_calculated   ON scores(calculated_at DESC);
`;

// ─── TypeScript types (match the SQL schema) ──────────────────────────────────

export type TrustTier = 'unknown' | 'low' | 'medium' | 'high' | 'trusted';

export interface Wallet {
  address: string;
  first_seen: Date;
  last_seen: Date;
  tx_count: number;
  score: number;
  trust_tier: TrustTier;
  updated_at: Date;
}

export interface Transaction {
  id: string;
  wallet_address: string;
  facilitator: string;
  amount: number;
  timestamp: Date;
  success: boolean;
  tx_signature: string;
}

export interface Score {
  id: string;
  wallet_address: string;
  score: number;
  success_rate: number; // 0.0 – 1.0
  diversity: number;    // 0.0 – 1.0
  volume: number;       // total USDC
  age: number;          // days
  calculated_at: Date;
}

// ─── Drizzle ORM (optional — add drizzle-orm pkg if needed) ──────────────────
// Uncomment if you add: bun add drizzle-orm && bun add -D drizzle-kit
//
// import {
//   pgTable, text, timestamp, integer, numeric, boolean, uuid, index, check
// } from "drizzle-orm/pg-core";
// import { sql } from "drizzle-orm";
//
// export const wallets = pgTable("wallets", {
//   address:    text("address").primaryKey(),
//   first_seen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
//   last_seen:  timestamp("last_seen",  { withTimezone: true }).notNull().defaultNow(),
//   tx_count:   integer("tx_count").notNull().default(0),
//   score:      numeric("score", { precision: 6, scale: 2 }).notNull().default("0"),
//   trust_tier: text("trust_tier").notNull().default("unknown"),
//   updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
// });
//
// export const transactions = pgTable("transactions", {
//   id:             uuid("id").primaryKey().defaultRandom(),
//   wallet_address: text("wallet_address").notNull().references(() => wallets.address, { onDelete: "cascade" }),
//   facilitator:    text("facilitator").notNull(),
//   amount:         numeric("amount", { precision: 20, scale: 6 }).notNull().default("0"),
//   timestamp:      timestamp("timestamp", { withTimezone: true }).notNull(),
//   success:        boolean("success").notNull().default(true),
//   tx_signature:   text("tx_signature").unique().notNull(),
// });
//
// export const scores = pgTable("scores", {
//   id:             uuid("id").primaryKey().defaultRandom(),
//   wallet_address: text("wallet_address").notNull().references(() => wallets.address, { onDelete: "cascade" }),
//   score:          numeric("score", { precision: 6, scale: 2 }).notNull(),
//   success_rate:   numeric("success_rate", { precision: 5, scale: 4 }).notNull().default("0"),
//   diversity:      numeric("diversity", { precision: 5, scale: 4 }).notNull().default("0"),
//   volume:         numeric("volume", { precision: 20, scale: 6 }).notNull().default("0"),
//   age:            integer("age").notNull().default(0),
//   calculated_at:  timestamp("calculated_at", { withTimezone: true }).notNull().defaultNow(),
// });
