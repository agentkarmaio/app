-- 0009_transactions_counterparty.sql
-- Add nullable counterparty column + index on transactions.
--
-- The payee / resource-server address (the actual counterparty), distinct from
-- the `facilitator` that routed the payment. NULL for legacy rows + chains where
-- the payee is not yet extracted; scoring falls back to `facilitator` until the
-- per-chain indexer populates it. Activates the gated loyalty +
-- counterparty-diversity signals (see docs/counterparty-signal-followup.md).
--
-- Applied via `servel infra sql @agentkarma-db --remote KN --service db <thisfile>`
-- (scoped, idempotent — NOT db:push, which carries pre-existing wallets_pkey drift,
-- see memory reference_dbpush_drift). Mirrors the 0006 celo_agent_id pattern.

BEGIN;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS counterparty TEXT;

CREATE INDEX IF NOT EXISTS idx_transactions_counterparty
  ON transactions (counterparty);

COMMIT;
