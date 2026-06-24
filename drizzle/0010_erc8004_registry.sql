-- 0010_erc8004_registry.sql
-- Registry-mirror tables keyed by (chain, agent_id) — one row per ERC-8004
-- IdentityRegistry NFT and one row per ReputationRegistry feedback record.
--
-- WHY a separate table instead of `wallets`: `wallets` is keyed by (chain,
-- address) = the OWNER/operator address. ERC-8004 agents are NFTs (token ids);
-- a single operator routinely owns hundreds of agents (Celo ids 1..1000 map to
-- just 41 distinct owners). An address-keyed table structurally collapses a
-- fleet into one row, so it can never reflect the per-agent count 8004scan
-- reports (9.4k+ Celo agents). This mirror holds the registry 1:1 so AK can
-- match 8004scan's per-network agent + feedback totals and scan every agent.
--
-- Generic across EVM ERC-8004 chains (Celo + Arc share the contract shape;
-- Stellar/Soroban can populate the same table via its own scanner later).
-- NO foreign key to `wallets` — agent owners are not guaranteed to be
-- materialized there. erc8004_feedback FKs to erc8004_agents instead.
--
-- agent_id / feedback_index are BIGINT: ERC-8004 declares uint256/uint64. Real
-- ids are tiny today (<100k) but BIGINT costs nothing and removes the overflow
-- foot-gun the wallets.celo_agent_id INTEGER column carries.
--
-- Applied via `servel infra sql @agentkarma-db --remote KN --service db <thisfile>`
-- (scoped + idempotent — NOT db:push, which carries pre-existing wallets_pkey
-- drift; see memory reference_dbpush_drift). Mirrors the 0006/0009 pattern.

BEGIN;

CREATE TABLE IF NOT EXISTS erc8004_agents (
  chain               TEXT    NOT NULL,
  agent_id            BIGINT  NOT NULL,
  owner               TEXT    NOT NULL,
  agent_wallet        TEXT,
  token_uri           TEXT,
  registration        JSONB,
  registration_status TEXT    NOT NULL DEFAULT 'pending', -- inline|fetched|empty|unreachable|invalid|pending
  metadata_score      INTEGER NOT NULL DEFAULT 0,
  feedback_count      INTEGER NOT NULL DEFAULT 0,
  feedback_sum        NUMERIC(20, 6),
  feedback_avg        NUMERIC(10, 4),
  first_indexed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_indexed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_erc8004_agents_chain        ON erc8004_agents (chain);
CREATE INDEX IF NOT EXISTS idx_erc8004_agents_owner        ON erc8004_agents (owner);
CREATE INDEX IF NOT EXISTS idx_erc8004_agents_agent_wallet ON erc8004_agents (agent_wallet);
CREATE INDEX IF NOT EXISTS idx_erc8004_agents_metadata     ON erc8004_agents (metadata_score);

CREATE TABLE IF NOT EXISTS erc8004_feedback (
  chain          TEXT    NOT NULL,
  agent_id       BIGINT  NOT NULL,
  client         TEXT    NOT NULL,
  feedback_index BIGINT  NOT NULL,
  raw_value      TEXT,
  value          NUMERIC(20, 6),
  value_decimals INTEGER NOT NULL DEFAULT 0,
  tag1           TEXT    NOT NULL DEFAULT '',
  tag2           TEXT    NOT NULL DEFAULT '',
  revoked        BOOLEAN NOT NULL DEFAULT false,
  indexed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, agent_id, client, feedback_index),
  CONSTRAINT erc8004_feedback_agent_fkey
    FOREIGN KEY (chain, agent_id) REFERENCES erc8004_agents (chain, agent_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_erc8004_feedback_chain_agent ON erc8004_feedback (chain, agent_id);
CREATE INDEX IF NOT EXISTS idx_erc8004_feedback_client      ON erc8004_feedback (client);
CREATE INDEX IF NOT EXISTS idx_erc8004_feedback_revoked     ON erc8004_feedback (revoked);

COMMIT;
