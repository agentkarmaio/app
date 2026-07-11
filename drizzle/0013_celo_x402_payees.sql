-- 0013_celo_x402_payees.sql
-- Endpoint-driven x402 payee discovery for the Celo settlement indexer.
--
-- WHY: src/indexer/celo-x402.ts is a deliberate no-op until a facilitator/payee
-- address is seeded. Celo has no canonical x402 facilitator (thirdweb is
-- bring-your-own server wallet), and heuristic on-chain discovery
-- (scripts/celo-discover-facilitators.ts) only surfaces DEX routers. The
-- reliable signal is the agent's OWN declaration: a real x402 paywall answers
-- an unpaid request with HTTP 402 + an `accepts` body carrying `payTo`.
-- scripts/celo-x402-discover-payees.ts walks indexed Celo agents, probes their
-- declared endpoints (SSRF-guarded), and persists verified payees here. The
-- indexer unions the VERIFIED rows into its match set.
--
-- ATTRIBUTION-POISONING GUARD: a malicious agent could declare a victim's
-- address as `payTo` to make AK attribute the victim's stablecoin transfers as
-- the agent's provider signal. `verified` is TRUE only when `payTo` is
-- self-controlled by the source agent (== its owner / agentWallet on the
-- IdentityRegistry). Cross-address declarations land `verified=false` and are
-- NEVER fed to the indexer. `source_agent_id` tags provenance for audit.
--
-- Keyed (chain, address) per the multi-chain convention (mirrors wallets).
-- chain is 'celo' today but the table generalizes to any EVM x402 chain.
--
-- Applied via `servel infra sql @agentkarma-db --remote KN --service db <thisfile>`
-- (scoped + idempotent — NOT db:push, which carries pre-existing wallets_pkey
-- drift; see memory reference_dbpush_drift). Mirrors the 0010 pattern.

BEGIN;

CREATE TABLE IF NOT EXISTS celo_x402_payees (
  chain           TEXT    NOT NULL DEFAULT 'celo',
  address         TEXT    NOT NULL,                 -- lowercased EVM payTo
  source_agent_id BIGINT,                           -- ERC-8004 agentId (provenance)
  endpoint        TEXT,                             -- probed service endpoint
  asset           TEXT,                             -- Celo stablecoin contract address
  network         TEXT,                             -- raw x402 network (eip155:42220)
  verified        BOOLEAN NOT NULL DEFAULT false,   -- self-payee → indexer-eligible
  discovered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, address)
);

CREATE INDEX IF NOT EXISTS idx_celo_x402_payees_verified     ON celo_x402_payees (verified);
CREATE INDEX IF NOT EXISTS idx_celo_x402_payees_source_agent ON celo_x402_payees (source_agent_id);

COMMIT;
