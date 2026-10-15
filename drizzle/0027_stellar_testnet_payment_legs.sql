-- stellar-testnet: one `transactions` row per USDC transfer leg, not per tx.
--
-- Bug: rows were keyed UNIQUE (chain, tx_signature) with tx_signature = the
-- transaction hash, so a transaction carrying several USDC payments to one
-- agent persisted only the first (e.g. 0.2 of a 0.2 + 0.8 pair). stellar-testnet
-- rows now store tx_signature = "<operationId>:<transferIndex>" (still unique
-- per chain, so the existing ON CONFLICT (chain, tx_signature) writers need no
-- change) and keep the on-chain hash in the new `tx_hash` column. Every other
-- chain leaves tx_hash NULL and is untouched.
--
-- Backfill: rows indexed before this change are keyed by hash and cannot be
-- re-keyed in place (the operation id is not recoverable from the hash), so
-- they are removed together with the stellar-testnet transfer cursors. The next
-- `indexer:stellar-testnet-transfers` runs (hourly via stellar-testnet-refresh,
-- 5 pages x 200 records per agent per run, oldest first) re-walk Horizon from
-- the start and re-insert every leg, including the dropped ones. The rows are a
-- derived index of public testnet data; wallets, registry rows and
-- usdc_transfer_settled signal events (keyed per tx hash) are left alone.
-- Affected wallets are re-enqueued for rescoring by the indexer (markDirty).
--
-- Apply BEFORE deploying the code that writes tx_hash. Idempotent.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "tx_hash" text;
DELETE FROM "transactions" WHERE "chain" = 'stellar-testnet' AND "tx_hash" IS NULL;
DELETE FROM "indexer_cursors"
  WHERE "chain" = 'stellar-testnet' AND "facilitator" LIKE 'stellar-transfers:%';
COMMIT;
NOTIFY pgrst, 'reload schema';
