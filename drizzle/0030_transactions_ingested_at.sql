-- Ingest time on `transactions`, so API-only payment rows can be streamed in the
-- order AgentKarma stored them (GET /api/v2/payments/{chain}).
--
-- Chain time (`timestamp`) cannot drive an incremental feed: the transfers
-- indexer walks each agent's history oldest first, so a newly seeded agent's
-- rows arrive with old timestamps, behind a reader's cursor. `ingested_at` only
-- moves forward.
--
-- Cheap on the 2.3M-row table: ADD COLUMN without a default and SET DEFAULT
-- are catalog-only (no rewrite); the DEFAULT stamps new rows from now on.
-- Existing stellar-testnet rows (hundreds) are backfilled with their chain time
-- so the feed starts with full history; every other chain stays NULL.
--
-- The partial index serves the feed's keyset read. Testnet rows are few, but
-- building it still scans the whole table: on the live database run the CREATE
-- INDEX CONCURRENTLY line by hand first (it cannot run inside a transaction);
-- IF NOT EXISTS then makes the line below a no-op.
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_api_only_ingest
--     ON transactions (chain, ingested_at, id) WHERE chain = 'stellar-testnet' AND ingested_at IS NOT NULL;
--
-- Apply out-of-band (servel infra sql @agentkarma-db --service db <this file>)
-- BEFORE deploying the code that reads the column, then restart the `rest`
-- service: PostgREST's schema cache on this cluster ignores NOTIFY pgrst.
-- Idempotent.
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "ingested_at" timestamp with time zone;
ALTER TABLE "transactions" ALTER COLUMN "ingested_at" SET DEFAULT now();
UPDATE "transactions" SET "ingested_at" = "timestamp"
  WHERE "chain" = 'stellar-testnet' AND "ingested_at" IS NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_api_only_ingest
  ON transactions (chain, ingested_at, id) WHERE chain = 'stellar-testnet' AND ingested_at IS NOT NULL;
NOTIFY pgrst, 'reload schema';
