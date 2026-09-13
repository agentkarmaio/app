import { expect, test } from 'bun:test';

test('profile cache arguments and underlying readers retain network identity', () => {
  // Isolate the next/cache stub in a subprocess; never replace global modules
  // used by unrelated test files running in this Bun process.
  const script = `
    import { mock, spyOn } from 'bun:test';
    mock.module('next/cache', () => ({ unstable_cache: (fn, keys) => {
      const memo = new Map();
      return (...args) => { const key=JSON.stringify([keys,args]); if(!memo.has(key))memo.set(key,fn(...args)); return memo.get(key); };
    }}));
    const live = await import('./src/scoring/live-agent-score');
    const card = await import('./src/lib/agent-card-fields');
    const liveCalls=[]; const cardCalls=[];
    spyOn(live,'computeAgentLiveBundle').mockImplementation(async (wallet,chain)=>{liveCalls.push([wallet,chain]);return {marker:chain};});
    spyOn(card,'resolveAgentCardFields').mockImplementation(async (wallet,opts)=>{cardCalls.push([wallet,opts]);return {chain:opts.chain};});
    const cache=await import('./src/db/cached');
    const db=await import('./src/db/client');
    spyOn(db,'getLeaderboard').mockResolvedValue({wallets:[{address:'same',chain:'arc',score:0},{address:'same',chain:'arc-mainnet',score:0}],total:2});
    spyOn(db,'getFeedbackSummariesForWallets').mockImplementation(async (addresses,chain)=>new Map([['same',{total:1,deliveryRate:chain==='arc-mainnet'?0.8:0.2}]]));
    spyOn(db,'getScoreHistoriesForWallets').mockImplementation(async (addresses,days,max,chain)=>new Map([['same',[{score:chain==='arc-mainnet'?88:22}]]]));
    const a=await cache.cachedAgentLiveBundle('same-address','arc');
    const b=await cache.cachedAgentLiveBundle('same-address','arc-mainnet');
    await cache.cachedAgentLiveBundle('same-address','arc-mainnet');
    const c=await cache.cachedAgentCardFields('same-address',null,'arc-mainnet');
    const leaderboard=await cache.cachedLeaderboardEntries();
    const unsupportedRegistry=await cache.getCachedEvmAgentOnchain('arc-mainnet',42);
    console.log(JSON.stringify({a,b,c,liveCalls,cardCalls,leaderboard,unsupportedRegistry}));
  `;
  const result = Bun.spawnSync(['bun', '-e', script], { cwd: process.cwd() });
  expect(result.exitCode).toBe(0);
  const data = JSON.parse(result.stdout.toString().trim());
  expect(data.a.marker).toBe('arc');
  expect(data.b.marker).toBe('arc-mainnet');
  expect(data.c.chain).toBe('arc-mainnet');
  expect(data.liveCalls).toEqual([['same-address', 'arc'], ['same-address', 'arc-mainnet']]);
  expect(data.cardCalls).toEqual([['same-address', { agentId: null, chain: 'arc-mainnet' }]]);
  expect(data.leaderboard).toMatchObject([
    {chain:'arc',trend:[22],delivery:{deliveryRate:0.2}},
    {chain:'arc-mainnet',trend:[88],delivery:{deliveryRate:0.8}},
  ]);
  expect(data.unsupportedRegistry).toEqual({agent:null,feedback:null});
});
