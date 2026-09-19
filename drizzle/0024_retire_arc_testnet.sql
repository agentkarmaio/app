-- Retire Arc Testnet without deleting historical identities, receipts or cursors.
-- Held leases are revoked; the repeatable SQL fence rejects future arc writes.
INSERT INTO indexing_state (chain, path, enabled, interval_ms)
VALUES ('arc', 'escrow', false, 300000),
       ('arc', 'transfers', false, 300000),
       ('arc', 'registry', false, 900000)
ON CONFLICT (chain, path) DO NOTHING;

UPDATE indexing_state
SET enabled = false, owner = NULL, lease_until = NULL
WHERE chain = 'arc';
