-- Repeatable migration (idempotent CREATE OR REPLACE) — re-applied on every
-- deploy via `bun run db:functions`. Trailing NOTIFY reloads PostgREST's schema
-- cache so the view is reachable over REST immediately.
--
-- `explore_agents` unifies the two agent populations behind the "All chains"
-- leaderboard so its count + list match reality:
--   • Solana lives in `wallets` (address-keyed, score-gated).
--   • Celo/Arc/Stellar agents are ERC-8004 registry entries in `erc8004_agents` —
--     one owner controls many, so the address-keyed `wallets` table can't
--     represent them 1:1. The registry mirror is the per-agent source.
-- Celo/Arc/Stellar `wallets` rows are deliberately EXCLUDED here (the registry
-- mirror supersedes them) so an owner-fleet isn't double-counted against its
-- agents. Stellar joined that set on 2026-08-05: its 67 registered agentIds
-- collapsed to 11 owner rows in `wallets`, hiding 56 agents.
-- Column projection matches the `wallets` shape getAgents() filters/sorts on.
--
-- Registry rows project NULL autonomy/Tier-2 metrics. Behavioral data is a
-- property of the ADDRESS and lives in `wallets`; joining it here would put a
-- ~85k-row join behind every all-chains count. The per-chain registry page
-- enriches from `wallets` in a bounded per-page lookup instead
-- (getRegistryAgentsPage).

-- Agent logo, denormalized onto wallets so list queries reading `wallets`
-- directly (the homepage leaderboard) can render it. Idempotent + co-located so
-- it runs before the view that projects the column, regardless of apply order.
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS image_url text;

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
    -- Appended last: CREATE OR REPLACE VIEW only permits adding columns at the
    -- end, never inserting mid-list.
    image_url
  FROM wallets
  WHERE chain = 'solana' AND score > 0
  UNION ALL
  SELECT
    chain,
    -- EVM getAgentWallet() returns the zero address when no custom wallet was
    -- set — the effective operator is the owner, so coalesce zero → owner.
    -- Soroban returns Option<Address>, so an unset Stellar wallet is NULL and
    -- the same COALESCE resolves it to the owner.
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
    registration->>'image'               AS image_url
  FROM erc8004_agents
  WHERE chain IN ('celo', 'arc', 'stellar');

GRANT SELECT ON explore_agents TO anon, authenticated, service_role;

-- Trust-tier distribution of the canonical agent population. Counts the
-- `explore_agents` view (NOT raw `wallets`) so getStats().totalAgents — summed
-- from these grouped counts — equals the Explore "All" count exactly. Lives
-- here, after the view, because a `LANGUAGE sql` function body is validated
-- against its referenced relations at CREATE time: the view MUST exist first,
-- and co-location guarantees that regardless of cross-file apply order.
CREATE OR REPLACE FUNCTION get_tier_distribution()
RETURNS TABLE(trust_tier text, count bigint) AS $$
  SELECT trust_tier, COUNT(*)::bigint
  FROM explore_agents
  GROUP BY trust_tier;
$$ LANGUAGE sql STABLE;

NOTIFY pgrst, 'reload schema';
