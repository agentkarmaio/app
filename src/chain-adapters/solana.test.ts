/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { makeSolanaAdapter } from './solana';

const a = makeSolanaAdapter();
const GOOD = 'So11111111111111111111111111111111111111112'; // wrapped SOL mint, valid base58 pubkey

describe('makeSolanaAdapter', () => {
  test('chain is solana', () => { expect(a.chain).toBe('solana'); });
  test('validateAddress accepts a base58 pubkey, rejects junk', () => {
    expect(a.validateAddress(GOOD)).toBe(true);
    expect(a.validateAddress('0xdeadbeef')).toBe(false);
    expect(a.validateAddress('')).toBe(false);
  });
  test('normalizeAddress round-trips a valid pubkey unchanged', () => {
    expect(a.normalizeAddress(GOOD)).toBe(GOOD);
  });
  test('explorer URLs target solscan', () => {
    expect(a.explorerTxUrl('sig')).toBe('https://solscan.io/tx/sig');
    expect(a.explorerAddressUrl(GOOD)).toBe(`https://solscan.io/account/${GOOD}`);
  });
});

describe('solana publish targets the agent asset', () => {
  const SCORE = { score: 81, trustTier: 'Very Good' } as never;

  test('a wallet with no 8004 agent identity is skipped, nothing is written', async () => {
    const writes: string[] = [];
    const adapter = makeSolanaAdapter({
      findAgentAsset: async () => null,
      writeFeedback: async (asset) => { writes.push(asset); return { signature: 'x', dryRun: false }; },
      readAgentFeedback: async () => [],
      publisher: () => 'AK',
    });
    const r = await adapter.publishAttestation(GOOD, SCORE);
    expect(r.skipped).toBe(true);
    expect(r.reason).toContain('no 8004 agent');
    expect(writes).toEqual([]);
  });

  test('writes karma_score to the ONE canonical asset the wallet controls — never to the wallet', async () => {
    const writes: string[] = [];
    const adapter = makeSolanaAdapter({
      findAgentAsset: async () => 'ASSET1',
      writeFeedback: async (asset) => { writes.push(asset); return { signature: 'sig1', dryRun: false }; },
      readAgentFeedback: async () => [],
      publisher: () => 'AK',
    });
    const r = await adapter.publishAttestation(GOOD, SCORE);
    expect(writes).toEqual(['ASSET1']);
    expect(r).toMatchObject({ skipped: false, txId: 'sig1' });
  });

  test("readAttestation is AK's own last published score on the asset (drift check)", async () => {
    const adapter = makeSolanaAdapter({
      findAgentAsset: async () => 'ASSET1',
      writeFeedback: async () => ({ dryRun: true }),
      readAgentFeedback: async () => [
        { client: 'AK', tag1: 'karma_score', score: 77, revoked: false, feedbackIndex: 2n },
        { client: 'X', tag1: 'karma_score', score: 99, revoked: false, feedbackIndex: 4n },
        { client: 'X', tag1: 'reachable', score: 10, revoked: false, feedbackIndex: 5n },
      ],
      publisher: () => 'AK',
    });
    expect(await adapter.readAttestation(GOOD)).toBe(77);
  });
});
