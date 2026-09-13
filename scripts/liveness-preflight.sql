-- Pre-flight for drizzle/0019_backfill_observed_last_seen.sql. Read-only.
--
--   servel infra sql @agentkarma-db --remote KN --service db \
--     scripts/liveness-preflight.sql
--
-- 0019 decides what to NULL by EXISTS(evidence rows); its assertion judges the
-- result by `tx_count`. Those two agree only if every wallet holding evidence
-- has been scored since. Scoring lags (dirty queue), so measure the disagreement
-- BEFORE the backfill rather than reading it back afterwards as a "violation".

-- A. Has transactions but tx_count = 0 — unscored, not unobserved. After 0019
--    these get a real last_seen and then trip the tx_count-based assertion.
--    Non-zero is expected-ish: rescore them, or judge the invariant on evidence
--    (observed <=> NOT NULL) rather than on tx_count.
SELECT 'has_tx_but_txcount_0' AS check, count(*)
  FROM wallets w
 WHERE w.tx_count = 0
   AND EXISTS (SELECT 1 FROM transactions t WHERE t.wallet_address = w.address);

-- B. tx_count > 0 but NEITHER evidence source has a row. Must be 0. Non-zero
--    means a THIRD writer feeds tx_count that 0019 does not know about — find it
--    before statement 3 nulls the only timestamp those rows have.
SELECT 'txcount_but_no_evidence' AS check, count(*)
  FROM wallets w
 WHERE w.tx_count > 0
   AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.wallet_address = w.address)
   AND NOT EXISTS (
         SELECT 1 FROM signal_events s
          WHERE s.agent_wallet = w.address
            AND s.kind = 'paysh_routed' AND s.face = 'provider');

-- C. If B is non-zero, this names the chains to look at first.
SELECT w.chain, count(*) AS orphan_txcount
  FROM wallets w
 WHERE w.tx_count > 0
   AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.wallet_address = w.address)
   AND NOT EXISTS (
         SELECT 1 FROM signal_events s
          WHERE s.agent_wallet = w.address
            AND s.kind = 'paysh_routed' AND s.face = 'provider')
 GROUP BY w.chain
 ORDER BY orphan_txcount DESC;

-- D. Size of the rewrite, so the runtime is not a surprise.
SELECT 'wallets_total' AS check, count(*) FROM wallets;
SELECT 'wallets_with_tx' AS check, count(DISTINCT wallet_address) FROM transactions;
SELECT 'paysh_operators' AS check, count(DISTINCT agent_wallet)
  FROM signal_events WHERE kind = 'paysh_routed' AND face = 'provider';
