-- 0016 — Arc address casing repair (data migration, one-off, idempotent)
--
-- Arc ingest wrote EIP-55 CHECKSUMMED addresses into wallets / transactions /
-- signal_events while every AK read path lowercases EVM addresses. Result on
-- 2026-08-17: 83,221 of 84,024 arc `wallets` rows were unreachable orphans,
-- growing ~300 every 6h run, with some agents present twice in two casings.
-- The ingest side is fixed in src/indexer/arc-{jobs,transfers}.ts (normalized at
-- both the parser and the DB-write loop); this file repairs the rows already
-- written.
--
-- ORDER MATTERS. The FKs into wallets(chain, address) are ON DELETE CASCADE with
-- NO ON UPDATE, so a parent rename does not follow. We therefore:
--   1. pre-create the lowercase parents,
--   2. repoint every child column onto them,
--   3. delete the now-childless checksummed parents.
-- No deferred constraints are needed, and every statement is a no-op on a
-- second run (`WHERE x <> lower(x)` is empty once applied).
--
-- Verified before writing this file (prod, 2026-08-17):
--   * all 84,000 mixed-case arc `wallets` rows are IDENTITY-ONLY — score 0,
--     trust_tier 'Unrated', tx_count 0, and every nullable column NULL — so
--     step 1's bare (chain, address) insert loses nothing.
--   * exactly 38 of them already have a lowercase twin (the merge cases).
--   * child rows carrying arc mixed-case values:
--       transactions.wallet_address  64,285 / 64,419
--       transactions.counterparty    63,895 / 64,419 (490 NULL)
--       signal_events.agent_wallet  133,919 / 135,736
--       bonds.bonded_agent_wallet         3 / 3
--       bond_underwriters.underwriter_wallet 6 / 6
--     scores, feedback, organization_members, agent_manifests and successions
--     hold ZERO arc rows.
--
-- Apply out-of-band as a single file. NOT via `bun db:push` (known drift, exits
-- 0 on error) and NOT via `servel infra sql ./drizzle --track` (the migrations
-- table is empty, so it would re-run 0006-0015).

BEGIN;

-- The 136k-row UPDATE below is well past this DB's default statement_timeout,
-- which is exactly the 57014 that has been killing keep-fresh runs.
SET LOCAL statement_timeout = '15min';

-- 0. signal_events carries uniq_signal_events_dedup (chain, agent_wallet, kind,
--    tx_ref). If a lowercase row already exists for the same key — which the
--    fixed indexer can produce for a re-scanned window — lowercasing the
--    checksummed row would violate it. Drop those checksummed duplicates first;
--    they are byte-identical signals under a different casing.
DELETE FROM signal_events s
WHERE s.chain = 'arc'
  AND s.agent_wallet <> lower(s.agent_wallet)
  AND EXISTS (
    SELECT 1 FROM signal_events t
    WHERE t.chain = 'arc'
      AND t.agent_wallet = lower(s.agent_wallet)
      AND t.kind = s.kind
      AND t.tx_ref IS NOT DISTINCT FROM s.tx_ref
  );

-- 1. Pre-create the lowercase parent for every checksummed row, so the child
--    repoint in step 2 always has an FK target. Identity only — the schema
--    defaults supply the rest, and ON CONFLICT DO NOTHING protects the 38 rows
--    whose lowercase twin already exists (those keep their score/agent_id).
INSERT INTO wallets (chain, address)
SELECT DISTINCT 'arc', lower(address)
FROM wallets
WHERE chain = 'arc' AND address <> lower(address)
ON CONFLICT (chain, address) DO NOTHING;

-- 2. Repoint every child column. counterparty is not an FK but feeds the
--    loyalty/diversity counterparty signals, so it must move too.
UPDATE transactions SET wallet_address = lower(wallet_address)
WHERE chain = 'arc' AND wallet_address <> lower(wallet_address);

UPDATE transactions SET counterparty = lower(counterparty)
WHERE chain = 'arc' AND counterparty IS NOT NULL AND counterparty <> lower(counterparty);

UPDATE signal_events SET agent_wallet = lower(agent_wallet)
WHERE chain = 'arc' AND agent_wallet <> lower(agent_wallet);

UPDATE bonds SET bonded_agent_wallet = lower(bonded_agent_wallet)
WHERE chain = 'arc' AND bonded_agent_wallet <> lower(bonded_agent_wallet);

UPDATE bond_underwriters SET underwriter_wallet = lower(underwriter_wallet)
WHERE chain = 'arc' AND underwriter_wallet <> lower(underwriter_wallet);

-- 3. The checksummed parents now have no children pointing at them, so this
--    DELETE cascades into nothing.
DELETE FROM wallets
WHERE chain = 'arc' AND address <> lower(address);

COMMIT;

-- Verification (run after COMMIT; every count must be 0):
--   SELECT count(*) FROM wallets       WHERE chain='arc' AND address       <> lower(address);
--   SELECT count(*) FROM transactions  WHERE chain='arc' AND wallet_address<> lower(wallet_address);
--   SELECT count(*) FROM transactions  WHERE chain='arc' AND counterparty IS NOT NULL AND counterparty <> lower(counterparty);
--   SELECT count(*) FROM signal_events WHERE chain='arc' AND agent_wallet  <> lower(agent_wallet);
-- And these must be UNCHANGED from before the run:
--   SELECT count(*) FROM transactions  WHERE chain='arc';   -- 64,419
--   SELECT count(*) FROM signal_events WHERE chain='arc';   -- 135,736 minus any step-0 duplicates
-- While wallets drops by exactly the number of merged twins:
--   SELECT count(*) FROM wallets       WHERE chain='arc';   -- 84,024 → 83,986 (38 merged)
