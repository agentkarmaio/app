-- 0012_claim_proof.sql
-- Persist the off-chain proof of ownership captured at claim time.
--
-- Claiming an agent is a signature, not an on-chain transaction: the keyholder
-- signs the canonical challenge "AgentKarma: Claim wallet {address} at {ts}"
-- (Ed25519 for Solana/Stellar, EIP-191 personal_sign for Celo/Arc) and the
-- claim routes verify it server-side. Until now that signature was discarded
-- after verification, leaving the "Claimed" badge unverifiable by a visitor.
--
-- These two columns store the signed challenge + signature so the agent page
-- can render a re-verifiable receipt. NOT an on-chain attestation — they prove
-- key control over the claimed address at claim time, nothing more.
--
-- Additive + nullable: every existing row stays NULL (we never captured a
-- signature for past claims and will not fabricate one). The agent page hides
-- the proof block when both are NULL.

BEGIN;

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS claim_signature TEXT,
  ADD COLUMN IF NOT EXISTS claim_message   TEXT;

COMMIT;
