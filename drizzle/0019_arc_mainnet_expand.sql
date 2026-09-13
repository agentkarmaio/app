-- Phase 1 of Arc mainnet rollout. Generated schema diff from 331d7b4,
-- split to retain legacy ON CONFLICT(tx_signature) writers during deployment.
-- Apply this file explicitly BEFORE deploying composite-conflict writers.
-- numeric widening can rewrite the transactions table and rebuild indexes;
-- review lock/disk/runtime headroom before production execution.
-- Mainnet remains disabled through both phases; activation is separate.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "transactions" ALTER COLUMN "amount" SET DATA TYPE numeric(38, 18);--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "amount" SET DEFAULT '0';--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_chain_tx_signature_unique" ON "transactions" USING btree ("chain","tx_signature");--> statement-breakpoint
ALTER TABLE "indexing_state" DROP CONSTRAINT "indexing_state_chain_check";--> statement-breakpoint
ALTER TABLE "indexing_state" ADD CONSTRAINT "indexing_state_chain_check" CHECK ("indexing_state"."chain" IN ('solana', 'arc', 'celo', 'stellar', 'arc-mainnet'));
INSERT INTO indexing_state(chain,path,enabled,interval_ms)
VALUES ('arc-mainnet','transfers',false,300000)
ON CONFLICT (chain,path) DO NOTHING;
COMMIT;
NOTIFY pgrst, 'reload schema';
