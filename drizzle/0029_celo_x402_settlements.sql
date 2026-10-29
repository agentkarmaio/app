-- Relayer-mode Celo x402 settlements (src/db/schema.ts: celoX402SettlementsTable),
-- written by src/indexer/celo-x402-relayer.ts. Quarantine: scoring, stats and
-- graph never read this table. Additive only; idempotent.
CREATE TABLE IF NOT EXISTS "celo_x402_settlements" (
	"chain" text DEFAULT 'celo' NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"relayer" text NOT NULL,
	"token" text NOT NULL,
	"symbol" text NOT NULL,
	"payer" text NOT NULL,
	"payee" text NOT NULL,
	"amount_raw" numeric(78, 0) NOT NULL,
	"amount" numeric NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "celo_x402_settlements_pkey" PRIMARY KEY("chain","tx_hash","log_index")
);
CREATE INDEX IF NOT EXISTS "idx_celo_x402_settlements_payer" ON "celo_x402_settlements" USING btree ("payer");
CREATE INDEX IF NOT EXISTS "idx_celo_x402_settlements_payee" ON "celo_x402_settlements" USING btree ("payee");
CREATE INDEX IF NOT EXISTS "idx_celo_x402_settlements_block_time" ON "celo_x402_settlements" USING btree ("block_time");
ALTER TABLE "celo_x402_settlements" ENABLE ROW LEVEL SECURITY;
NOTIFY pgrst, 'reload schema';
