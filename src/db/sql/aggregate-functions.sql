-- Transaction aggregate stats
CREATE OR REPLACE FUNCTION get_transaction_stats()
RETURNS TABLE(total_count bigint, total_volume numeric) AS $$
  SELECT COUNT(*)::bigint, COALESCE(SUM(amount), 0)
  FROM transactions;
$$ LANGUAGE sql STABLE;

-- Facilitator stats grouped by facilitator
CREATE OR REPLACE FUNCTION get_facilitator_stats()
RETURNS TABLE(
  facilitator text,
  tx_count bigint,
  unique_agents bigint,
  total_volume numeric,
  last_active timestamptz
) AS $$
  SELECT
    facilitator,
    COUNT(*)::bigint AS tx_count,
    COUNT(DISTINCT wallet_address)::bigint AS unique_agents,
    COALESCE(SUM(amount), 0) AS total_volume,
    MAX(timestamp) AS last_active
  FROM transactions
  GROUP BY facilitator
  ORDER BY tx_count DESC;
$$ LANGUAGE sql STABLE;
