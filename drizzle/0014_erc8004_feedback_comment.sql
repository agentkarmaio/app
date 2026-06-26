-- 0014_erc8004_feedback_comment.sql
-- Surface ERC-8004 feedback comments (free-text reviews) on agent profiles.
--
-- ERC-8004's giveFeedback carries `feedbackURI` + `feedbackHash` (and `endpoint`),
-- but the registry EMITS them in the NewFeedback event WITHOUT storing them
-- on-chain (see ERC8004SPEC). readAllFeedback — what the registry scanner uses —
-- therefore can't return them. AgentKarma inlines a reviewer's free text as a
-- `data:application/json` URI in feedbackURI, with feedbackHash = keccak256 of
-- those exact bytes. A separate NewFeedback event scan backfills these columns.
--
-- comment_verified = the decoded data-URI bytes hashed to the on-chain
-- feedbackHash (integrity proven locally, no trust in AK). NULL comment = no
-- inline review, which is every pre-existing and score-only record.
--
-- Additive + nullable: existing rows keep NULL / FALSE. Safe to re-run.

BEGIN;

ALTER TABLE erc8004_feedback
  ADD COLUMN IF NOT EXISTS feedback_uri     TEXT,
  ADD COLUMN IF NOT EXISTS feedback_hash    TEXT,
  ADD COLUMN IF NOT EXISTS comment          TEXT,
  ADD COLUMN IF NOT EXISTS comment_verified BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
