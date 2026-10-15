-- Payers whose payments to an agent are not counted as revenue on
-- stellar-testnet (src/db/schema.ts: stellarTestnetExcludedPayersTable).
-- Additive only; ships EMPTY — addresses are inserted by the operator, never by
-- a migration. Read by the stellar_testnet_agents and
-- stellar_testnet_received_payments views (src/db/sql/stellar-testnet-agents-view.sql),
-- which must be re-applied after this (`bun run db:functions`). Idempotent.
CREATE TABLE IF NOT EXISTS "stellar_testnet_excluded_payers" (
	"address" text PRIMARY KEY NOT NULL,
	"note" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "stellar_testnet_excluded_payers" ENABLE ROW LEVEL SECURITY;
NOTIFY pgrst, 'reload schema';
