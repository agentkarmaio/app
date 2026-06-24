-- 0011_erc8004_value_widen.sql
-- Widen the ERC-8004 feedback value columns to unbounded NUMERIC.
--
-- ERC-8004 ReputationRegistry feedback values are arbitrary int128 with a
-- per-record uint8 decimals scale. Most are sane ratings (0..100), but the open
-- registry contains records whose normalized value (raw / 10^decimals) exceeds
-- the bounded numeric(20,6)/(10,4) we first chose — the full Celo scan tripped
-- "numeric field overflow" (22003) on feedback_avg near agentId ~9300. Storing
-- the registry faithfully (no clamping) means unbounded NUMERIC; downstream
-- scoring can bound at read time. raw_value (TEXT) remains the exact source.
--
-- Applied via `servel infra sql @agentkarma-db --remote KN --service db <thisfile>`
-- (scoped + idempotent). ALTER … TYPE NUMERIC widens in place, no data loss.

BEGIN;

ALTER TABLE erc8004_feedback ALTER COLUMN value         TYPE NUMERIC;
ALTER TABLE erc8004_agents   ALTER COLUMN feedback_sum  TYPE NUMERIC;
ALTER TABLE erc8004_agents   ALTER COLUMN feedback_avg  TYPE NUMERIC;

COMMIT;

NOTIFY pgrst, 'reload schema';
