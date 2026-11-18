-- Agent Bond (slashable self-stake), stellar-testnet only. Additive, idempotent.
-- Written by src/indexer/stellar-agent-bond.ts from contract events
-- (contracts/agent-bond). Scoring reads these tables directly
-- (src/db/client.ts getAgentBondInput); signal_events rows are timeline only.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Current state per bond, set from each event's post-state totals.
CREATE TABLE IF NOT EXISTS "agent_bonds" (
	"chain" text NOT NULL,
	"agent_id" integer NOT NULL,
	"contract_id" text NOT NULL,
	"owner_wallet" text NOT NULL,
	"bonded" numeric(30, 7) NOT NULL,
	"unbonding" numeric(30, 7) NOT NULL,
	"unlock_at" timestamp with time zone,
	"slashed_total" numeric(30, 7) NOT NULL DEFAULT 0,
	"first_deposit_at" timestamp with time zone NOT NULL,
	"last_ledger" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_bonds_pkey" PRIMARY KEY ("chain", "contract_id", "agent_id"),
	CONSTRAINT "agent_bonds_chain_check" CHECK ("chain" = 'stellar-testnet'),
	CONSTRAINT "agent_bonds_owner_fkey" FOREIGN KEY ("chain", "owner_wallet")
		REFERENCES "wallets" ("chain", "address") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_agent_bonds_owner" ON "agent_bonds" USING btree ("chain", "owner_wallet");

-- Raw event log: source for slash history and the 30-day seasoning window.
CREATE TABLE IF NOT EXISTS "agent_bond_events" (
	"chain" text NOT NULL,
	"contract_id" text NOT NULL,
	"event_id" text NOT NULL,
	"tx_hash" text NOT NULL,
	"ledger" integer NOT NULL,
	"ledger_closed_at" timestamp with time zone NOT NULL,
	"agent_id" integer NOT NULL,
	"owner_wallet" text NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(30, 7) NOT NULL,
	"bonded" numeric(30, 7) NOT NULL,
	"unbonding" numeric(30, 7) NOT NULL,
	"evidence_kind" text,
	"evidence_id" text,
	"evidence" jsonb,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_bond_events_pkey" PRIMARY KEY ("chain", "contract_id", "event_id"),
	CONSTRAINT "agent_bond_events_chain_check" CHECK ("chain" = 'stellar-testnet'),
	CONSTRAINT "agent_bond_events_kind_check" CHECK ("kind" IN ('deposited', 'unbond_requested', 'withdrawn', 'slashed')),
	CONSTRAINT "agent_bond_events_evidence_check" CHECK (("kind" = 'slashed') = ("evidence_id" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "idx_agent_bond_events_owner_ledger" ON "agent_bond_events" USING btree ("chain", "owner_wallet", "ledger");
CREATE INDEX IF NOT EXISTS "idx_agent_bond_events_agent" ON "agent_bond_events" USING btree ("chain", "contract_id", "agent_id", "ledger");

ALTER TABLE "agent_bonds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_bond_events" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.agent_bonds FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.agent_bond_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_bonds TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_bond_events TO service_role;

-- New indexing path.
ALTER TABLE "indexing_state" DROP CONSTRAINT IF EXISTS "indexing_state_path_check";
ALTER TABLE "indexing_state" ADD CONSTRAINT "indexing_state_path_check"
  CHECK ("indexing_state"."path" IN ('payments', 'escrow', 'transfers', 'registry', 'bonds'));
INSERT INTO indexing_state (chain, path, enabled, interval_ms)
VALUES ('stellar-testnet', 'bonds', true, 3600000)
ON CONFLICT (chain, path) DO NOTHING;
COMMIT;
NOTIFY pgrst, 'reload schema';
