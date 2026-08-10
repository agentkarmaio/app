-- Repeatable migration (see aggregate-functions.sql). Applied via
-- `bun run db:functions`, which runs on every `bun run deploy`.
--
-- Serves BOTH /api/stats aggregates in aggregate-functions.sql as index-only
-- scans, so neither reads the heap:
--   get_transaction_stats  COUNT(*), SUM(amount)                  FROM transactions
--   get_facilitator_stats  GROUP BY facilitator, COUNT(*),
--                          COUNT(DISTINCT wallet_address),
--                          SUM(amount), MAX(timestamp)            FROM transactions
--
-- Column order is load-bearing: leading with `facilitator` lets the GROUP BY
-- read in index order (no sort), and putting `wallet_address` next turns the
-- COUNT DISTINCT into a walk over already-sorted groups. `amount` and
-- `timestamp` are along for the ride so the scan never has to visit the table.
--
-- Measured 2026-08-10 at 948,939 rows (up from ~502k in June): the heap-scan
-- versions ran 1342ms and 3808ms, and get_transaction_stats had already begun
-- tripping the statement timeout (57014) under contention — getStats then
-- served last-known-good figures instead of fresh ones. Both aggregates are
-- O(n) either way; this cuts the constant, and buys room to several million
-- rows before an incrementally-maintained rollup becomes worth its complexity
-- (COUNT DISTINCT wallet_address is what makes that rollup non-trivial).
--
-- NOTE: prod already has this index — created 2026-08-10 with CREATE INDEX
-- CONCURRENTLY (non-locking on a live table), which cannot run inside a
-- transaction and so could not go through this file. IF NOT EXISTS makes this a
-- no-op there; it exists so a fresh database gets the index too. If you ever
-- need to (re)create it on a live table, do it CONCURRENTLY by hand rather than
-- letting this file lock writes while it builds.

CREATE INDEX IF NOT EXISTS idx_transactions_stats_covering
  ON transactions (facilitator, wallet_address, amount, timestamp);

-- Keep the index-only scan actually index-only.
--
-- An index-only scan may skip the heap only for pages the visibility map marks
-- all-visible, and only VACUUM sets those bits. `transactions` is append-only,
-- so it accumulates almost no dead tuples (1,642 against 950k live rows on
-- 2026-08-10) and never reaches the dead-tuple threshold. That leaves PG 15's
-- insert-driven autovacuum as the only trigger, and at the default
-- insert_scale_factor of 0.2 it needs ~190k new rows: last autovacuum here was
-- 2026-07-13, a month and ~450k inserts earlier. In between, every freshly
-- inserted page is invisible to the VM, the planner sees a scan that would have
-- to hit the heap anyway, and it falls back to the sequential scan this index
-- exists to avoid.
--
-- 0.02 vacuums after ~2% growth (~19k rows, roughly daily at current ingest) —
-- cheap on an append-only table, and it keeps both the VM and the planner's
-- statistics current. Measured right after a manual VACUUM ANALYZE: the full
-- aggregate went 1854ms -> 623ms and the facilitator GROUP BY 3808ms -> 1259ms.
ALTER TABLE transactions SET (
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.02
);

NOTIFY pgrst, 'reload schema';
