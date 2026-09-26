-- Repeatable migration (idempotent CREATE OR REPLACE) — re-applied on every
-- deploy via `bun run db:functions`. Trailing NOTIFY reloads PostgREST's schema
-- cache so the view is reachable over REST immediately.
--
-- Arc testnet rows remain in their source tables as a read-only archive.
-- Active discovery and totals exclude them.
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
-- Registry identities keep their declared score semantics while measured wallet
-- metrics join on (chain, effective address). This preserves every agentId and
-- lets All and per-chain filters/sorts operate before pagination. Missing wallet
-- measurements remain NULL; the composite wallet primary key prevents fan-out.

-- Agent logo, denormalized onto wallets so list queries reading `wallets`
-- directly (the homepage leaderboard) can render it. Idempotent + co-located so
-- it runs before the view that projects the column, regardless of apply order.
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS image_url text;

-- Evidence-weighted ranking key. The raw `score` mixes signal tiers: Tier-3
-- declared metadata quality reaches 100 with zero observed activity, while the
-- behavioral score tops out around 80 — so an unweighted sort put 0-tx declared
-- registrations above every observed agent. GENERATED, never written by the app
-- (PostgREST's write cache is stale on this cluster; see
-- docs/superpowers/specs/2026-08-25-evidence-weighted-leaderboard-ranking.md).
-- Keep the weight in sync with drizzle/0017_evidence_weighted_rank.sql and with
-- the registry branch of the view below.
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS rank_score numeric(6,2)
  GENERATED ALWAYS AS (score * CASE WHEN confidence_badge = 'declared' THEN 0.7 ELSE 1.0 END) STORED;

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
    image_url,
    rank_score,
    -- Appended for registry-owner search when the payment wallet differs.
    NULL::text AS registry_owner
  FROM wallets
  WHERE chain = 'solana' AND score > 0
  UNION ALL
  SELECT
    r.chain,
    -- EVM zero address and Soroban NULL both mean the owner is the operator.
    COALESCE(NULLIF(r.agent_wallet, '0x0000000000000000000000000000000000000000'), r.owner) AS address,
    r.registration->>'name'              AS display_name,
    false                                AS claimed,
    r.metadata_score::numeric            AS provider_score,
    NULL::numeric                        AS consumer_score,
    CASE
      WHEN r.metadata_score <= 20 THEN 'Unrated'
      WHEN r.metadata_score <= 40 THEN 'Poor'
      WHEN r.metadata_score <= 60 THEN 'Fair'
      WHEN r.metadata_score <= 75 THEN 'Good'
      WHEN r.metadata_score <= 90 THEN 'Very Good'
      ELSE 'Excellent'
    END                                  AS trust_tier,
    'declared'                           AS confidence_badge,
    w.autonomy_score, w.autonomy_label, COALESCE(w.tx_count, 0) AS tx_count,
    -- Only observed activity; registry scan timestamps are not liveness.
    w.last_seen,
    w.metric_success_rate, w.metric_diversity, w.metric_volume, w.metric_age, w.metric_cadence,
    CASE WHEN r.chain = 'celo'    THEN r.agent_id END AS celo_agent_id,
    NULL::bigint AS arc_agent_id,
    CASE WHEN r.chain = 'stellar' THEN r.agent_id END AS stellar_agent_id,
    r.metadata_score::numeric            AS score,
    r.registration->>'image'             AS image_url,
    -- This score remains declared even when orthogonal wallet metrics exist.
    (r.metadata_score::numeric * 0.7)    AS rank_score,
    r.owner AS registry_owner
  FROM erc8004_agents r
  LEFT JOIN wallets w ON w.chain = r.chain
    AND w.address = COALESCE(NULLIF(r.agent_wallet, '0x0000000000000000000000000000000000000000'), r.owner)
  WHERE r.chain IN ('celo', 'stellar')
  UNION ALL
  -- Mainnet metadata identifies agents; only observed transfers supply Karma.
  -- Join on the composite wallet key so testnet scores cannot leak across.
  SELECT
    r.chain,
    COALESCE(NULLIF(r.agent_wallet, '0x0000000000000000000000000000000000000000'), r.owner),
    r.registration->>'name', COALESCE(w.claimed, false),
    CASE WHEN w.confidence_badge = 'behavior-inferred' THEN w.provider_score END,
    w.consumer_score, COALESCE(w.trust_tier, 'Unrated'), COALESCE(w.confidence_badge, 'declared'),
    w.autonomy_score, w.autonomy_label, COALESCE(w.tx_count, 0), w.last_seen,
    w.metric_success_rate, w.metric_diversity, w.metric_volume, w.metric_age, w.metric_cadence,
    NULL::bigint, r.agent_id, NULL::bigint,
    COALESCE(w.score, 0), r.registration->>'image', COALESCE(w.rank_score, 0), r.owner
  FROM erc8004_agents r
  LEFT JOIN wallets w ON w.chain = r.chain
    AND w.address = COALESCE(NULLIF(r.agent_wallet, '0x0000000000000000000000000000000000000000'), r.owner)
  WHERE r.chain = 'arc-mainnet';

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
