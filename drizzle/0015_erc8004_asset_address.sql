-- 0015_erc8004_asset_address.sql
-- Chain-native identity-object address on the ERC-8004 registry mirror.
--
-- On Celo, Arc and Stellar an agent IS its agent_id — the registry contract
-- keys everything by it, and (chain, agent_id) is a complete identity. Solana's
-- 8004-solana is different: the identity is a minted asset NFT, and
-- `giveFeedback(client, agentAccount, asset, collection, …)` cannot be built
-- without that pubkey. It is not derivable from agent_id, and the indexer API
-- offers no agent_id → asset lookup, so it must be persisted at scan time.
--
-- Generalized rather than named `solana_asset`: any future chain whose identity
-- object is distinct from its sequential id lands in the same column.
--
-- Additive + nullable: existing Celo/Arc/Stellar rows keep NULL, and
-- upsertErc8004Agents only writes the column for chains that supply it, so
-- re-scans never blank it. Safe to re-run.

BEGIN;

ALTER TABLE erc8004_agents
  ADD COLUMN IF NOT EXISTS asset_address TEXT;

CREATE INDEX IF NOT EXISTS idx_erc8004_agents_asset_address
  ON erc8004_agents (asset_address);

COMMIT;

-- PostgREST caches the schema; a new column is invisible to the API until the
-- cache reloads. NOTIFY does that WITHOUT restarting the service — restarting
-- one supabase service reschedules its stateful siblings and has taken prod
-- down before (see feedback_servel_service_restart_cascade).
NOTIFY pgrst, 'reload schema';
