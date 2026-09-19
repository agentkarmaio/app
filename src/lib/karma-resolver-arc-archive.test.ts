import { afterEach, expect, spyOn, test } from 'bun:test';
import { __setSupabaseForTest } from '@/db/client';
import type { Wallet } from '@/db/schema';
import * as arc from '@/integrations/erc8004-arc';
import * as celo from '@/integrations/erc8004-celo';
import { resolveEvmKarma } from './karma-resolver';

const owner = '0x' + '12'.repeat(20);
const spies: { mockRestore(): void }[] = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); __setSupabaseForTest(null); });

for (const exists of [true, false]) {
  test(`Arc MCP snapshot reads only archived metadata (archive exists=${exists})`, async () => {
    let rpcCalls = 0;
    spies.push(spyOn(arc, 'readAgent').mockImplementation(async () => { rpcCalls++; throw Error('RPC must remain unused'); }));
    spies.push(spyOn(arc, 'aggregateFeedback').mockImplementation(async () => { rpcCalls++; throw Error('RPC must remain unused'); }));
    const filters: string[] = [];
    __setSupabaseForTest({ from(table: string) {
      const query = {
        select: () => query, order: () => query,
        eq: (key: string, value: unknown) => { filters.push(`${table}.${key}=${value}`); return query; },
        maybeSingle: async () => ({ data: exists ? { owner, agent_wallet: owner, token_uri: 'ipfs://archived', registration: { name: 'Archived Agent', services: [{ name: 'MCP', endpoint: 'https://archive.example.com/mcp' }] }, feedback_count: 1, feedback_avg: '75' } : null, error: null }),
        range: async () => ({ data: [], error: null }),
      };
      return query;
    } });
    const snapshot = await resolveEvmKarma(owner, 'arc', { chain: 'arc', address: owner, arc_agent_id: 72077, provider_score: 40 } as Wallet);
    expect(rpcCalls).toBe(0);
    expect(filters).toContain('erc8004_agents.chain=arc');
    expect(filters).toContain('erc8004_agents.agent_id=72077');
    expect(snapshot?.owner).toBe(exists ? owner : null);
    expect(snapshot?.agentURI).toBe(exists ? 'ipfs://archived' : null);
    expect(snapshot?.explorerUrls.agentkarma).toBe(`https://agentkarma.io/agent/${owner}?chain=arc&agentId=72077`);
    expect(snapshot?.services).toHaveLength(exists ? 1 : 0);
    expect(snapshot?.onChainFeedback?.average ?? null).toBe(exists ? 75 : null);
  });
}

test('Celo resolution retains its live identity and feedback readers', async () => {
  const calls: string[] = [];
  spies.push(spyOn(celo, 'readAgent').mockImplementation(async () => { calls.push('identity'); throw Error('read unavailable'); }));
  spies.push(spyOn(celo, 'aggregateFeedback').mockImplementation(async () => { calls.push('feedback'); throw Error('read unavailable'); }));
  __setSupabaseForTest({ from() { throw Error('Celo resolution must not use the retired archive'); } });
  const result = await resolveEvmKarma(owner, 'celo', { chain: 'celo', address: owner, celo_agent_id: 9058 } as Wallet);
  expect(calls).toEqual(['identity', 'feedback']);
  expect(result?.chain).toBe('celo');
});
