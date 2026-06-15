-- 0006_celo_agent_id.sql
-- Add celo_agent_id column + index on wallets.
--
-- Mirrors the existing stellar_agent_id pattern (see 0004_multichain.sql).
-- INTEGER is sufficient: ERC-8004 declares uint256 but the current Celo tip
-- is <10k and grows ~linearly with registrations; we are not at risk of
-- overflowing int4 in any realistic horizon. NULL = wallet has no bound
-- Celo agentId yet (the default for every existing row).
--
-- Filled by scripts/celo-backfill-agents.ts during the one-shot materialize
-- of the ERC-8004 Celo IdentityRegistry into the wallets table.

BEGIN;

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS celo_agent_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_wallets_celo_agent_id
  ON wallets (celo_agent_id);

COMMIT;
