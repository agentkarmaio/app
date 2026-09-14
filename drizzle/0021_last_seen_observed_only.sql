-- `wallets.last_seen` means OBSERVED activity, not row-write time (2026-09-13).
--
-- The column defaulted to now() and `upsertWallet` stamped it on every write, so
-- it recorded OUR indexer cadence rather than the agent's. Two visible failures:
--
--   * 309 declared-only Arc + Celo agents (tx_count 0, backfilled 2026-06-11)
--     crossed the 90-day threshold together on 2026-09-09 and rendered a red
--     "Inactive" — a death verdict derived from no evidence at all.
--   * A Solana wallet with 397 transactions read "Dormant" because 2026-07-01
--     was the last time we rescored it.
--
-- After this, NULL is the honest value for "nothing observed", and the app
-- renders it as the `Unobserved` liveness state. The invariant the backfill
-- establishes and the app maintains:
--
--     tx_count = 0  <=>  last_seen IS NULL
--
-- Full rationale: docs/superpowers/specs/2026-09-13-observed-liveness.md
--
-- Migrations on this cluster are applied out of band (servel.migrations is
-- empty while 0006-0020 are live), so run this by hand:
--   servel infra sql @agentkarma-db --remote KN --service db \
--     drizzle/0021_last_seen_observed_only.sql
--
-- Then backfill the existing 96k rows:
--   bun run scripts/backfill-observed-last-seen.ts --dry-run
--   bun run scripts/backfill-observed-last-seen.ts --apply

ALTER TABLE wallets ALTER COLUMN last_seen DROP DEFAULT;
ALTER TABLE wallets ALTER COLUMN last_seen DROP NOT NULL;
