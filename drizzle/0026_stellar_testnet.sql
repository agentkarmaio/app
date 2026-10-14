-- stellar-testnet: API-only chain key (Kerem, 2026-10-14). Idempotent.
--
-- No chain-keyed table except indexing_state carries a CHECK on `chain`
-- (wallets/transactions/erc8004_* are composite-keyed free text), so this only
-- widens that constraint and registers the two GitHub-Actions-run paths.
-- In-app workers never schedule them (startIndexingWorkers skips API-only
-- chains); stellar-testnet-refresh.yml runs them via src/scripts/indexing-run.ts.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "indexing_state" DROP CONSTRAINT IF EXISTS "indexing_state_chain_check";
ALTER TABLE "indexing_state" ADD CONSTRAINT "indexing_state_chain_check"
  CHECK ("indexing_state"."chain" IN ('solana', 'arc', 'celo', 'stellar', 'arc-mainnet', 'stellar-testnet'));
INSERT INTO indexing_state (chain, path, enabled, interval_ms)
VALUES ('stellar-testnet', 'registry', true, 3600000),
       ('stellar-testnet', 'transfers', true, 3600000)
ON CONFLICT (chain, path) DO NOTHING;
COMMIT;
NOTIFY pgrst, 'reload schema';
