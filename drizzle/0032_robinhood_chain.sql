-- robinhood: Robinhood Chain (EVM, chainId 4663), registry-only (Kerem,
-- 2026-11-24). Idempotent.
--
-- No chain-keyed table except indexing_state carries a CHECK on `chain`
-- (wallets/transactions/erc8004_* are composite-keyed free text), so this only
-- widens that constraint and registers the registry path DISABLED. An operator
-- enables it after the deploy is verified:
--   UPDATE indexing_state SET enabled = true WHERE chain = 'robinhood' AND path = 'registry';
-- Spec: docs/superpowers/specs/2026-11-24-robinhood-chain-8004-registry.md
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "indexing_state" DROP CONSTRAINT IF EXISTS "indexing_state_chain_check";
ALTER TABLE "indexing_state" ADD CONSTRAINT "indexing_state_chain_check"
  CHECK ("indexing_state"."chain" IN ('solana', 'arc', 'celo', 'stellar', 'arc-mainnet', 'stellar-testnet', 'robinhood'));
INSERT INTO indexing_state (chain, path, enabled, interval_ms)
VALUES ('robinhood', 'registry', false, 3600000)
ON CONFLICT (chain, path) DO NOTHING;
COMMIT;
NOTIFY pgrst, 'reload schema';
