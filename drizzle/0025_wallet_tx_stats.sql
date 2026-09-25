-- Per-wallet settlement counters for the Arc settlement walk
-- (src/indexer/arc-mainnet-settlement-walk.ts). Generated from
-- src/db/schema.ts (walletTxStatsTable); additive only — no destructive
-- statements, so this is applied directly instead of an interactive
-- drizzle-kit push (whose wallets_pkey drift prompt must not be applied).
CREATE TABLE IF NOT EXISTS "wallet_tx_stats" (
	"chain" text DEFAULT 'solana' NOT NULL,
	"address" text NOT NULL,
	"settled_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"last_block" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_tx_stats_pkey" PRIMARY KEY("chain","address")
);