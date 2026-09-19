-- Retirement adds an active-network predicate to both aggregate RPCs.
-- Keep facilitator grouping index-only without fetching chain from the heap.
-- On a populated database create this index CONCURRENTLY before deployment;
-- this repeatable definition then becomes a no-op (same existing index pattern).
CREATE INDEX IF NOT EXISTS idx_transactions_active_stats_covering
  ON transactions (facilitator, wallet_address, amount, timestamp)
  WHERE chain <> 'arc';
