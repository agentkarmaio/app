-- Repeatable migration (idempotent CREATE OR REPLACE) — re-applied on every
-- deploy via `bun run db:functions`. Trailing NOTIFY reloads PostgREST.
--
-- `stellar_testnet_agents`: the API-only stellar-testnet population (Kerem,
-- 2026-10-14). Deliberately a SEPARATE view, never a branch of
-- `explore_agents`: that view feeds the public "All chains" list, its count and
-- get_tier_distribution(), so a testnet branch there would leak into every
-- public total. Only getAgents/getWalletByAgentId read this view, and only for
-- an explicit chain=stellar-testnet.
--
-- Same column projection as explore_agents, so the API serializer is shared.
-- One row per registry agentId (erc8004_agents, PK (chain, agent_id)); the
-- agent's address is its bound wallet, else the owner (Soroban NULL = unset).
--
-- Score semantics ("observed when present"): once the rescore queue has scored
-- the agent's wallet from indexed USDC receipts (badge receipt-backed or
-- behavior-inferred), that observed Karma is served. Until then the declared
-- registration-metadata score is served under the 'declared' badge — the same
-- formula and tier bands as the mainnet Stellar branch of explore_agents.

CREATE OR REPLACE VIEW stellar_testnet_agents AS
  SELECT
    r.chain,
    COALESCE(r.agent_wallet, r.owner)    AS address,
    r.registration->>'name'              AS display_name,
    COALESCE(w.claimed, false)           AS claimed,
    CASE WHEN o.observed THEN w.provider_score::numeric ELSE r.metadata_score::numeric END AS provider_score,
    CASE WHEN o.observed THEN w.consumer_score::numeric END AS consumer_score,
    CASE
      WHEN o.observed THEN w.trust_tier
      WHEN r.metadata_score <= 20 THEN 'Unrated'
      WHEN r.metadata_score <= 40 THEN 'Poor'
      WHEN r.metadata_score <= 60 THEN 'Fair'
      WHEN r.metadata_score <= 75 THEN 'Good'
      WHEN r.metadata_score <= 90 THEN 'Very Good'
      ELSE 'Excellent'
    END                                  AS trust_tier,
    CASE WHEN o.observed THEN w.confidence_badge ELSE 'declared' END AS confidence_badge,
    w.autonomy_score::numeric            AS autonomy_score,
    w.autonomy_label,
    COALESCE(w.tx_count, 0)              AS tx_count,
    w.last_seen,
    w.metric_success_rate::numeric       AS metric_success_rate,
    w.metric_diversity::numeric          AS metric_diversity,
    w.metric_volume::numeric             AS metric_volume,
    w.metric_age::numeric                AS metric_age,
    w.metric_cadence::numeric            AS metric_cadence,
    NULL::bigint                         AS celo_agent_id,
    NULL::bigint                         AS arc_agent_id,
    r.agent_id::bigint                   AS stellar_agent_id,
    CASE WHEN o.observed THEN w.score::numeric ELSE r.metadata_score::numeric END AS score,
    r.registration->>'image'             AS image_url,
    CASE WHEN o.observed THEN w.rank_score::numeric ELSE r.metadata_score::numeric * 0.7 END AS rank_score,
    r.owner                              AS registry_owner
  FROM erc8004_agents r
  LEFT JOIN wallets w ON w.chain = r.chain
    AND w.address = COALESCE(r.agent_wallet, r.owner)
  CROSS JOIN LATERAL (
    SELECT COALESCE(w.confidence_badge IN ('receipt-backed', 'behavior-inferred'), false) AS observed
  ) o
  WHERE r.chain = 'stellar-testnet';

GRANT SELECT ON stellar_testnet_agents TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
