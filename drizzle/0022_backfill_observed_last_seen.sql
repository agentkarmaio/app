-- One-time backfill for 0018: rewrite `wallets.last_seen` from write time to
-- OBSERVED activity. Run AFTER 0018 has dropped the NOT NULL / DEFAULT.
--
--   servel infra sql @agentkarma-db --remote KN --service db \
--     drizzle/0019_backfill_observed_last_seen.sql
--
-- Run as SQL, not through PostgREST: supabase-js carries a statement timeout
-- (the 57014 that has bitten the aggregate reads) and these are 96k-row updates.
--
-- Invariant established here and maintained by upsertWallet:
--     tx_count = 0  <=>  last_seen IS NULL
--
-- `tx_count` has TWO sources, so nulling by "absent from transactions" alone
-- would erase real activity for pay.sh operators, who are scored from
-- signal_events and have no `transactions` rows at all (indexer/index.ts).

-- The 57014 statement timeout lives on the PostgREST role, but do not assume
-- this session inherits none: these are ~207k-row rewrites.
SET statement_timeout = 0;

BEGIN;

-- 1. Scored wallets: newest observed transaction.
--    Grouped scan + hash join, not 96k correlated subqueries.
UPDATE wallets w
   SET last_seen = t.max_ts
  FROM (
    SELECT wallet_address, MAX(timestamp) AS max_ts
      FROM transactions
     GROUP BY wallet_address
  ) t
 WHERE w.address = t.wallet_address;

-- 2. pay.sh operators: newest routed receipt. GREATEST so an operator that also
--    has transactions keeps the later of the two.
UPDATE wallets w
   SET last_seen = GREATEST(w.last_seen, s.max_ts)
  FROM (
    SELECT agent_wallet, MAX(observed_at) AS max_ts
      FROM signal_events
     WHERE kind = 'paysh_routed' AND face = 'provider'
     GROUP BY agent_wallet
  ) s
 WHERE w.address = s.agent_wallet;

-- 3. Everything neither source covers was never observed.
UPDATE wallets w
   SET last_seen = NULL
 WHERE NOT EXISTS (
         SELECT 1 FROM transactions t WHERE t.wallet_address = w.address
       )
   AND NOT EXISTS (
         SELECT 1 FROM signal_events s
          WHERE s.agent_wallet = w.address
            AND s.kind = 'paysh_routed' AND s.face = 'provider'
       );

COMMIT;

-- `rank_score` is GENERATED ALWAYS … STORED, so every touched row is rewritten.
-- On this cluster indexes stay inert over the new heap until it is vacuumed
-- (the 2026-08 stats full-scan incident), so do not skip this.
VACUUM ANALYZE wallets;

-- Invariant assertion. Compare this against check A of
-- scripts/liveness-preflight.sql, run BEFORE this file: a wallet that holds
-- transactions but has not been scored yet still has tx_count = 0, so it gets a
-- real last_seen above and shows up here. That is scoring lag, not a bad
-- backfill, and the pre-flight count tells you how many to expect.
--
-- Anything BEYOND that number means a third writer feeds tx_count that this
-- file does not know about — find it before trusting the liveness column.
SELECT chain, count(*) AS violations
  FROM wallets
 WHERE (tx_count = 0) <> (last_seen IS NULL)
 GROUP BY chain;

-- The evidence-form of the same invariant, which this file implements directly
-- and which must be zero regardless of scoring lag.
SELECT 'unobserved_but_has_evidence' AS check, count(*)
  FROM wallets w
 WHERE w.last_seen IS NULL
   AND (EXISTS (SELECT 1 FROM transactions t WHERE t.wallet_address = w.address)
     OR EXISTS (SELECT 1 FROM signal_events s
                 WHERE s.agent_wallet = w.address
                   AND s.kind = 'paysh_routed' AND s.face = 'provider'));
