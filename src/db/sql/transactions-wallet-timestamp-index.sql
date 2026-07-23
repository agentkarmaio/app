-- Repeatable migration (see aggregate-functions.sql). Applied via
-- `bun run db:functions`, which runs on every `bun run deploy`.
--
-- Serves the per-wallet history read scoring depends on:
--   WHERE wallet_address = ? ORDER BY timestamp DESC LIMIT n
-- (getRecentTransactionsForWallet -> getTransactionsForWallets, rescore-dirty).
--
-- idx_transactions_chain_wallet_address cannot serve it: that index leads with
-- `chain`, which this query does not constrain, so Postgres scanned all 786k
-- rows and sorted. Measured 2026-07-23: ~2000ms per wallet, which exceeded the
-- statement timeout (57014) once an indexer run touched ~60 wallets. With this
-- index the same read is ~300ms, dominated by row serialization not the scan.
--
-- NOTE: prod already has this index — it was created 2026-07-23 with
-- CREATE INDEX CONCURRENTLY (non-locking on a live table), which cannot run
-- inside a transaction and so could not go through this file. IF NOT EXISTS
-- makes this a no-op there; it exists so a fresh database gets the index too.
-- If you ever need to (re)create it on a live table, do it CONCURRENTLY by hand
-- rather than letting this file lock writes while it builds.

CREATE INDEX IF NOT EXISTS idx_transactions_wallet_timestamp
  ON transactions (wallet_address, timestamp DESC);

NOTIFY pgrst, 'reload schema';
