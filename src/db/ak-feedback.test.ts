/// <reference types="bun-types" />
/**
 * getAkConnectedFeedback — the unified "feedback AK made on Celo" list backing
 * /celo: AK's own metadata-quality attestations (signed by an AK rater wallet)
 * PLUS independent reviews left through AK's give-feedback UX, read from the
 * registry mirror and joined to each target agent's name/address/stats.
 *
 * Stubs Supabase (via __setSupabaseForTest); the feedback and agents queries
 * both terminate on `.in()` (tag1 / agent_id), so a per-table fake resolving on
 * `.in` covers the whole chain. Asserts: metadata counts only when an AK wallet
 * signed it; non-AK metadata is dropped; reviews count regardless of rater;
 * value is normalized by valueDecimals; the agent-wallet zero address falls back
 * to owner; revoked records sink to the bottom.
 */
import { describe, expect, test, afterAll } from 'bun:test';
import { __setSupabaseForTest, getAkConnectedFeedback } from './client';
import { AK_RATER_ADDRESSES } from '@/config/ak-validator';

afterAll(() => { __setSupabaseForTest(null); });

const AK = AK_RATER_ADDRESSES[0];                 // a real AK rater wallet (lowercase)
const STRANGER = '0x000000000000000000000000000000000000dead';
const ZERO = '0x0000000000000000000000000000000000000000';

type TableData = Record<string, { data?: unknown[]; error?: unknown }>;

function makeFakeSupabase(byTable: TableData) {
  return {
    from(table: string) {
      const result = byTable[table] ?? { data: [], error: null };
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      // Both queries (feedback `.in('tag1')`, agents `.in('agent_id')`) end on .in().
      builder.in = () => Promise.resolve({ data: result.data ?? [], error: result.error ?? null });
      return builder;
    },
  };
}

describe('getAkConnectedFeedback', () => {
  test('AK-signed metadata is included and joined to the target agent', async () => {
    __setSupabaseForTest(makeFakeSupabase({
      erc8004_feedback: {
        data: [{
          agent_id: 17, client: AK.toUpperCase(), feedback_index: 3, value: 100, value_decimals: 0,
          tag1: 'agentkarma_metadata', tag2: 'v0.1', revoked: false,
        }],
      },
      erc8004_agents: {
        data: [{
          agent_id: 17, owner: '0xowner', agent_wallet: '0xwallet',
          registration: { name: 'Loopuman' }, metadata_score: 100, feedback_count: 1349,
        }],
      },
    }));

    const out = await getAkConnectedFeedback('celo');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      agentId: 17, kind: 'metadata', tag1: 'agentkarma_metadata', tag2: 'v0.1',
      feedbackIndex: 3, value: 100, revoked: false,
      targetName: 'Loopuman', targetAddress: '0xwallet',
      targetMetadataScore: 100, targetFeedbackCount: 1349,
    });
  });

  test('metadata signed by a non-AK wallet is dropped', async () => {
    __setSupabaseForTest(makeFakeSupabase({
      erc8004_feedback: {
        data: [{
          agent_id: 5, client: STRANGER, feedback_index: 0, value: 90, value_decimals: 0,
          tag1: 'agentkarma_metadata', tag2: 'v0.1', revoked: false,
        }],
      },
      erc8004_agents: { data: [] },
    }));
    expect(await getAkConnectedFeedback('celo')).toEqual([]);
  });

  test('a review counts regardless of rater, tagged kind=review', async () => {
    __setSupabaseForTest(makeFakeSupabase({
      erc8004_feedback: {
        data: [{
          agent_id: 8, client: STRANGER, feedback_index: 1, value: 80, value_decimals: 0,
          tag1: 'agentkarma_review', tag2: 'v0.1', revoked: false,
        }],
      },
      erc8004_agents: {
        data: [{ agent_id: 8, owner: '0xo', agent_wallet: null, registration: null, metadata_score: 0, feedback_count: 1 }],
      },
    }));
    const out = await getAkConnectedFeedback('celo');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      agentId: 8, kind: 'review', tag1: 'agentkarma_review', feedbackIndex: 1,
      value: 80, client: STRANGER,
    });
  });

  test('value is normalized by valueDecimals (850 @ dec 1 → 85)', async () => {
    __setSupabaseForTest(makeFakeSupabase({
      erc8004_feedback: {
        data: [{
          // feedback_index intentionally omitted → defaults to 0.
          agent_id: 1, client: AK, value: 850, value_decimals: 1,
          tag1: 'agentkarma_metadata', tag2: 'v0.1', revoked: false,
        }],
      },
      erc8004_agents: {
        data: [{ agent_id: 1, owner: '0xo', agent_wallet: ZERO, registration: { name: 'Arron C.' }, metadata_score: 85, feedback_count: 14 }],
      },
    }));
    const out = await getAkConnectedFeedback('celo');
    expect(out[0].value).toBe(85);
    // A null/absent feedback_index normalizes to 0.
    expect(out[0].feedbackIndex).toBe(0);
    // agent_wallet is the zero address → display address falls back to the owner.
    expect(out[0].targetAddress).toBe('0xo');
  });

  test('records sort live-first, then by value desc', async () => {
    __setSupabaseForTest(makeFakeSupabase({
      erc8004_feedback: {
        data: [
          { agent_id: 2, client: AK, feedback_index: 0, value: 75, value_decimals: 0, tag1: 'agentkarma_metadata', tag2: 'v0.1', revoked: false },
          { agent_id: 3, client: AK, feedback_index: 0, value: 100, value_decimals: 0, tag1: 'agentkarma_metadata', tag2: 'v0.1', revoked: true },
          { agent_id: 4, client: AK, feedback_index: 0, value: 90, value_decimals: 0, tag1: 'agentkarma_metadata', tag2: 'v0.1', revoked: false },
        ],
      },
      erc8004_agents: {
        data: [
          { agent_id: 2, owner: '0xo2', agent_wallet: '0xw2', registration: null, metadata_score: 75, feedback_count: 0 },
          { agent_id: 3, owner: '0xo3', agent_wallet: '0xw3', registration: null, metadata_score: 100, feedback_count: 0 },
          { agent_id: 4, owner: '0xo4', agent_wallet: '0xw4', registration: null, metadata_score: 90, feedback_count: 0 },
        ],
      },
    }));
    const out = await getAkConnectedFeedback('celo');
    expect(out.map((r) => r.agentId)).toEqual([4, 2, 3]); // 90, 75 (live) then revoked 100
  });

  test('no AK-connected feedback returns []', async () => {
    __setSupabaseForTest(makeFakeSupabase({ erc8004_feedback: { data: [] } }));
    expect(await getAkConnectedFeedback('celo')).toEqual([]);
  });
});
