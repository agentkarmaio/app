import { afterEach, expect, test } from 'bun:test';
import { __setSupabaseForTest } from './client';
import { getCachedEvmAgentOnchain } from './cached';

afterEach(() => __setSupabaseForTest(null));

test('Arc profile reads saved identity and revoked feedback without a live RPC or Next cache', async () => {
  const filters: string[] = [];
  const owner = '0x' + '12'.repeat(20);
  __setSupabaseForTest({ from(table: string) {
    const query = {
      select() { return query; },
      eq(key: string, value: unknown) { filters.push(`${table}.${key}=${value}`); return query; },
      order() { return query; },
      maybeSingle: async () => ({ data: { owner, agent_wallet: owner, token_uri: 'ipfs://saved', registration: { name: 'Archived Agent' }, feedback_count: 1, feedback_avg: '80' }, error: null }),
      range: async () => ({ data: [
        { client: owner, feedback_index: 0, raw_value: '8000', value_decimals: 2, value: '80', tag1: 'karma', tag2: '', revoked: false },
        { client: owner, feedback_index: 1, raw_value: '100', value_decimals: 0, value: '100', tag1: 'karma', tag2: '', revoked: true },
      ], error: null }),
    };
    return query;
  } });
  const result = await getCachedEvmAgentOnchain('arc', 72077);
  expect(result.agent?.registration?.name).toBe('Archived Agent');
  expect(result.agent?.agentId).toBe(72077n);
  expect(result.feedback?.count).toBe(1);
  expect(result.feedback?.average).toBe(80);
  expect(result.feedback?.records).toHaveLength(2);
  expect(result.feedback?.records[0].rawValue).toBe(8000n);
  expect(result.feedback?.records[1].revoked).toBe(true);
  for (const table of ['erc8004_agents', 'erc8004_feedback']) {
    expect(filters).toContain(`${table}.chain=arc`);
    expect(filters).toContain(`${table}.agent_id=72077`);
  }
});

test('a missing archive does not claim a zero-score identity or fallback to RPC', async () => {
  __setSupabaseForTest({ from() {
    const query = { select() { return query; }, eq() { return query; }, order() { return query; }, maybeSingle: async () => ({ data: null, error: null }), range: async () => ({ data: [], error: null }) };
    return query;
  } });
  expect(await getCachedEvmAgentOnchain('arc', 7)).toEqual({ agent: null, feedback: null });
});
