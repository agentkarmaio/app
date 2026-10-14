-- Repeatable migration (see aggregate-functions.sql). Re-applied idempotently via
-- `bun run db:functions`; the trailing NOTIFY reloads PostgREST so the RPC is
-- reachable over REST. cleanup_score_snapshots is invoked from getStats' sibling
-- cleanup path via supabase.rpc(), so it must be in the schema cache.

CREATE OR REPLACE FUNCTION cleanup_score_snapshots(retention_days integer DEFAULT 90)
RETURNS bigint AS $$
DECLARE
  deleted_count bigint;
BEGIN
  -- Latest snapshot per (chain, wallet): a G-address can hold rows on both
  -- stellar and stellar-testnet (and an EVM address on several chains). Keyed on
  -- the address alone, only ONE chain's latest snapshot survived and the
  -- other chain's could be deleted.
  WITH latest_per_wallet AS (
    SELECT DISTINCT ON (chain, wallet_address) id
    FROM scores
    ORDER BY chain, wallet_address, calculated_at DESC
  ),
  deletable AS (
    SELECT s.id FROM scores s
    WHERE s.chain <> 'arc'
    AND s.calculated_at < NOW() - make_interval(days => retention_days)
    AND s.id NOT IN (SELECT id FROM latest_per_wallet)
  )
  DELETE FROM scores WHERE id IN (SELECT id FROM deletable);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Make the (re)created function visible to PostgREST without a service restart.
NOTIFY pgrst, 'reload schema';
