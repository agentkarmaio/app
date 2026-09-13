-- Phase 2: apply explicitly only AFTER every app/CLI/CI writer has switched
-- to ON CONFLICT(chain,tx_signature) and all old writer processes are drained.
-- This removes a uniqueness restriction; it deletes/rewrites no rows or hashes.
-- Keep mainnet disabled until RPC identity, seeds and receipt decoding pass.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM indexing_state WHERE chain='arc-mainnet'
      AND path='transfers' AND NOT enabled AND owner IS NULL) THEN
    RAISE EXCEPTION 'arc_mainnet_must_remain_disabled_before_contract';
  END IF;
END $$;
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_tx_signature_unique";
COMMIT;
NOTIFY pgrst, 'reload schema';
