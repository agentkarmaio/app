import { afterEach, expect, test } from 'bun:test';
import { __setSupabaseForTest, getAgents, getLeaderboard, getWalletByAgentId, markWalletsDirty, claimDirtyWallets, countDirtyWallets, markAllWalletsDirty } from './client';

afterEach(() => __setSupabaseForTest(null));
function recorder(rows: unknown[] = []) {
  const calls: Array<{table:string; filters:unknown[][]; orders:string[]}> = [];
  __setSupabaseForTest({from(table:string) {
    const call = {table, filters:[] as unknown[][], orders:[] as string[]}; calls.push(call);
    const b:Record<string,unknown> = {};
    for(const m of ['select','update']) b[m]=()=>b;
    for(const m of ['eq','neq','not','gt','gte','lte','in','is','or']) b[m]=(...args:unknown[])=>{call.filters.push([m,...args]);return b;};
    b.order=(key:string)=>{call.orders.push(key);return b;};
    b.range=b.limit=()=>b;
    b.then=(resolve:(r:unknown)=>void)=>resolve({data:rows,error:null,count:rows.length});
    return b;
  }});
  return calls;
}
test('mainnet listing filters and sorts persisted scores before pagination',async()=>{
  const calls=recorder();
  await getAgents(10,20,{chain:'arc-mainnet',minProviderScore:5},{field:'provider_score',direction:'desc'});
  expect(calls[0].table).toBe('explore_agents');
  expect(calls[0].filters).toContainEqual(['eq','chain','arc-mainnet']);
  expect(calls[0].filters).toContainEqual(['gte','provider_score',5]);
  expect(calls[0].orders).toEqual(['rank_score','chain','address','celo_agent_id','arc_agent_id','stellar_agent_id']);
});
test('mainnet ID zero resolves exact registry identity from the ranking projection',async()=>{
  const calls=recorder([{chain:'arc-mainnet',address:'0xagent',arc_agent_id:0}]);
  expect((await getWalletByAgentId('arc-mainnet',0))?.address).toBe('0xagent');
  expect(calls[0].table).toBe('explore_agents');
  expect(calls[0].filters).toContainEqual(['eq','chain','arc-mainnet']);
  expect(calls[0].filters).toContainEqual(['eq','arc_agent_id',0]);
});
test('mainnet is never enqueued for the incompatible legacy scoring model',async()=>{
  const calls=recorder();
  await markWalletsDirty([{chain:'arc-mainnet',address:'same'},{chain:'arc',address:'same'}]);
  expect(calls).toHaveLength(1);
  expect(calls[0].filters).toContainEqual(['eq','chain','arc']);
});
for(const [name,run] of [['claim',()=>claimDirtyWallets()],['count',()=>countDirtyWallets()],['enqueue-all',()=>markAllWalletsDirty()]] as const) {
  test(`legacy queue ${name} excludes mainnet at the database`,async()=>{
    const calls=recorder(); await run();
    expect(calls[0].filters).toContainEqual(['neq','chain','arc-mainnet']);
  });
}

test('mainnet leaderboard keeps registry agents distinct', async () => {
  const calls=recorder(); await getLeaderboard(10,0,{chain:'arc-mainnet'});
  expect(calls[0].table).toBe('explore_agents');
  expect(calls[0].filters).toContainEqual(['eq','chain','arc-mainnet']);
});
