-- Repeatable migration. PostgREST-exposed aggregate RPCs behind /api/stats and
-- /explore. Re-applied verbatim (idempotent CREATE OR REPLACE) on every deploy
-- via `bun run db:functions`. Do NOT register with `servel … --track`: tracking
-- errors when a function body legitimately changes, and a "tracked = applied"
-- row does not guarantee the function still exists in the live DB. The trailing
-- NOTIFY reloads PostgREST's schema cache so a freshly (re)created function is
-- reachable over REST immediately — a stale cache returns PGRST202 and 500'd
-- /api/stats on 2026-06-18 (see project_stats_500_schema_cache).

-- Transaction aggregate stats
CREATE OR REPLACE FUNCTION get_transaction_stats()
RETURNS TABLE(total_count bigint, total_volume numeric) AS $$
  SELECT COUNT(*)::bigint, COALESCE(SUM(amount), 0)
  FROM transactions;
$$ LANGUAGE sql STABLE;

-- Wallet trust-tier distribution (grouped counts). Replaces fetching all ~116k
-- trust_tier rows in getStats — that row-stream blew the statement timeout and
-- 500'd /api/stats under load.
CREATE OR REPLACE FUNCTION get_tier_distribution()
RETURNS TABLE(trust_tier text, count bigint) AS $$
  SELECT trust_tier, COUNT(*)::bigint
  FROM wallets
  GROUP BY trust_tier;
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

-- Make the (re)created functions visible to PostgREST without a service restart.
NOTIFY pgrst, 'reload schema';
