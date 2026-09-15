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

-- Durable lease for the off-band public activity snapshot. The request path
-- reads the table row; only the worker claims and publishes expensive stats.
CREATE OR REPLACE FUNCTION claim_stats_snapshot(
  p_scope text,
  p_owner uuid,
  p_lease_ms integer
)
RETURNS TABLE(generation integer) AS $$
BEGIN
  RETURN QUERY
  UPDATE stats_snapshots
     SET owner = p_owner,
         lease_until = clock_timestamp() + p_lease_ms * interval '1 millisecond',
         last_attempt_at = clock_timestamp(),
         generation = stats_snapshots.generation + 1
   WHERE scope = p_scope
     AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp())
     AND (owner IS NULL OR lease_until IS NULL OR lease_until <= clock_timestamp())
  RETURNING stats_snapshots.generation;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION publish_stats_snapshot(
  p_scope text,
  p_owner uuid,
  p_generation integer,
  p_payload jsonb,
  p_as_of timestamptz
)
RETURNS boolean AS $$
BEGIN
  UPDATE stats_snapshots
     SET payload = p_payload,
         as_of = p_as_of,
         completed_at = clock_timestamp(),
         owner = NULL,
         lease_until = NULL,
         consecutive_failures = 0,
         last_error_code = NULL,
         next_attempt_at = NULL
   WHERE scope = p_scope AND owner = p_owner AND generation = p_generation
     AND lease_until > clock_timestamp();
  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION fail_stats_snapshot(
  p_scope text,
  p_owner uuid,
  p_generation integer,
  p_error_code text
)
RETURNS boolean AS $$
BEGIN
  UPDATE stats_snapshots
     SET owner = NULL,
         lease_until = NULL,
         last_failure_at = clock_timestamp(),
         last_error_code = p_error_code,
         consecutive_failures = consecutive_failures + 1,
         next_attempt_at = clock_timestamp() + LEAST(900, 15 * power(2, LEAST(consecutive_failures, 5))) * interval '1 second'
   WHERE scope = p_scope AND owner = p_owner AND generation = p_generation;
  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION claim_stats_snapshot(text, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION publish_stats_snapshot(text, uuid, integer, jsonb, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION fail_stats_snapshot(text, uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_stats_snapshot(text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION publish_stats_snapshot(text, uuid, integer, jsonb, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION fail_stats_snapshot(text, uuid, integer, text) TO service_role;

-- NOTE: get_tier_distribution() now lives in explore-agents-view.sql — it reads
-- the `explore_agents` view (the canonical agent population) so its summed counts
-- equal the Explore "All" total. It must be defined after that view, which the
-- co-location guarantees independent of file apply order.

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
