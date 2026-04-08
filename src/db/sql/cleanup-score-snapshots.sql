CREATE OR REPLACE FUNCTION cleanup_score_snapshots(retention_days integer DEFAULT 90)
RETURNS bigint AS $$
DECLARE
  deleted_count bigint;
BEGIN
  WITH latest_per_wallet AS (
    SELECT DISTINCT ON (wallet_address) id
    FROM scores
    ORDER BY wallet_address, calculated_at DESC
  ),
  deletable AS (
    SELECT s.id FROM scores s
    WHERE s.calculated_at < NOW() - make_interval(days => retention_days)
    AND s.id NOT IN (SELECT id FROM latest_per_wallet)
  )
  DELETE FROM scores WHERE id IN (SELECT id FROM deletable);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
