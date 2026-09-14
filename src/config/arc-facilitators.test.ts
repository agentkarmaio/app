import { describe, expect, test } from 'bun:test';
import { ARC_ESCROW_FACILITATOR, ARC_USDC_CONTRACT } from '@/config/arc-facilitators';
import { ARC_USDC_CONTRACT as INDEXER_USDC } from '@/indexer/arc-transfers';
import { ARC_JOBS_CONTRACT } from '@/indexer/arc-jobs';

/**
 * The client-safe copies must never drift from the indexer constants that
 * actually get written into `transactions.facilitator` — a silent drift would
 * make the profile label a real facilitator as unknown, or worse, label a real
 * router as a "direct transfer".
 */
describe('arc facilitator constants', () => {
  test('USDC contract matches the indexer source of truth', () => {
    expect(ARC_USDC_CONTRACT.toLowerCase()).toBe(INDEXER_USDC.toLowerCase());
  });

  test('job escrow matches the indexer source of truth', () => {
    expect(ARC_ESCROW_FACILITATOR.toLowerCase()).toBe(ARC_JOBS_CONTRACT.toLowerCase());
  });
});
