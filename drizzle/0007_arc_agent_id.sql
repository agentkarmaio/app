-- 0007_arc_agent_id.sql
-- Add arc_agent_id column + index on wallets.
--
-- Mirrors the existing celo_agent_id pattern (see 0006_celo_agent_id.sql) and
-- stellar_agent_id (see 0004_multichain.sql). INTEGER is sufficient: ERC-8004
-- declares uint256 but the current Arc Testnet tip sits in the low 10^5 (AK
-- itself is agentId 72077) — no risk of overflowing int4 in any realistic
-- horizon. NULL = wallet has no bound Arc agentId yet (the default for every
-- existing row).
--
-- Filled by scripts/arc-backfill-agents.ts during the one-shot materialize of
-- the ERC-8004 Arc Testnet IdentityRegistry into the wallets table.
--
-- Testnet marker: every row written by the backfill has arc_agent_id IS NOT
-- NULL AND chain='arc'. Arc has no mainnet today (launches summer 2026), so
-- chain='arc' rows are testnet by definition. Once Arc mainnet ships, a
-- distinct 'arc-mainnet' chain (or network column) can fork; the existing
-- testnet rows retain their visible chain='arc' marker.

BEGIN;

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS arc_agent_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_wallets_arc_agent_id
  ON wallets (arc_agent_id);

COMMIT;
