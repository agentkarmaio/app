-- Evidence-weighted leaderboard ranking (2026-08-25).
-- Spec: docs/superpowers/specs/2026-08-25-evidence-weighted-leaderboard-ranking.md
--
-- The raw `score` mixes signal tiers. Tier-3 declared metadata quality
-- (agentkarma_metadata v0.2 — a deterministic registration checklist with NO
-- activity input) reaches 100 with zero observed behavior, while Solana's
-- behavioral score tops out at 80.05 across 95k wallets. So every row above
-- 80.05 was declared-only by construction and the "All chains" leaderboard
-- opened with a block of 0-tx Celo/Arc agents.
--
-- `rank_score` re-weights the ranking key so a declaration cannot outrank
-- observed behavior. GENERATED ALWAYS … STORED, never written by the app:
-- PostgREST's schema cache on this cluster is stale and `NOTIFY pgrst` is inert,
-- so a new column is readable but NOT writable until the `rest` container
-- restarts. A generated column sidesteps that and can never drift from `score`.
--
-- Apply out-of-band, WITHOUT --track (the servel.migrations table is empty and
-- tracked files are skipped — which is also why this file re-states the view
-- instead of relying on the already-tracked explore-agents-view.sql):
--   servel infra sql @agentkarma-db --service db drizzle/0017_evidence_weighted_rank.sql
-- ADD COLUMN … STORED rewrites the table (ACCESS EXCLUSIVE on ~205k rows).
-- Deploy the app only AFTER this lands — code ordering on a missing column
-- fails with 42703 and takes the homepage down.

ALTER TABLE wallets ADD COLUMN IF NOT EXISTS rank_score numeric(6,2)
  GENERATED ALWAYS AS (score * CASE WHEN confidence_badge = 'declared' THEN 0.7 ELSE 1.0 END) STORED;

-- Partial index mirrors the read paths, which all gate on score > 0.
CREATE INDEX IF NOT EXISTS idx_wallets_rank_score
  ON wallets (rank_score DESC) WHERE score > 0;

-- View: same trailing-column addition as src/db/sql/explore-agents-view.sql.
-- Registry rows are 100% declared, so the weight is applied inline there.
CREATE OR REPLACE VIEW explore_agents AS
  SELECT
    chain, address, display_name, claimed,
    provider_score, consumer_score, trust_tier, confidence_badge,
    autonomy_score, autonomy_label, tx_count, last_seen,
    metric_success_rate, metric_diversity, metric_volume, metric_age, metric_cadence,
    celo_agent_id::bigint   AS celo_agent_id,
    arc_agent_id::bigint    AS arc_agent_id,
    stellar_agent_id::bigint AS stellar_agent_id,
    score,
    image_url,
    rank_score
  FROM wallets
  WHERE chain = 'solana' AND score > 0
  UNION ALL
  SELECT
    chain,
    COALESCE(NULLIF(agent_wallet, '0x0000000000000000000000000000000000000000'), owner) AS address,
    registration->>'name'                AS display_name,
    false                                AS claimed,
    metadata_score::numeric              AS provider_score,
    NULL::numeric                        AS consumer_score,
    CASE
      WHEN metadata_score <= 20 THEN 'Unrated'
      WHEN metadata_score <= 40 THEN 'Poor'
      WHEN metadata_score <= 60 THEN 'Fair'
      WHEN metadata_score <= 75 THEN 'Good'
      WHEN metadata_score <= 90 THEN 'Very Good'
      ELSE 'Excellent'
    END                                  AS trust_tier,
    'declared'                           AS confidence_badge,
    NULL::numeric                        AS autonomy_score,
    NULL::text                           AS autonomy_label,
    0                                    AS tx_count,
    last_indexed_at                      AS last_seen,
    NULL::numeric AS metric_success_rate,
    NULL::numeric AS metric_diversity,
    NULL::numeric AS metric_volume,
    NULL::numeric AS metric_age,
    NULL::numeric AS metric_cadence,
    CASE WHEN chain = 'celo'    THEN agent_id END AS celo_agent_id,
    CASE WHEN chain = 'arc'     THEN agent_id END AS arc_agent_id,
    CASE WHEN chain = 'stellar' THEN agent_id END AS stellar_agent_id,
    metadata_score::numeric              AS score,
    registration->>'image'               AS image_url,
    (metadata_score::numeric * 0.7)      AS rank_score
  FROM erc8004_agents
  WHERE chain IN ('celo', 'arc', 'stellar');

GRANT SELECT ON explore_agents TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
