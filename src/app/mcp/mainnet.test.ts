import { afterEach, expect, test, spyOn } from 'bun:test';
import { __setSupabaseForTest } from '@/db/client';
import { POST, chainSchema, chainFilterSchema, resolveForChain, fullKarmaJson } from './route';
import * as arc from '@/integrations/erc8004-arc';
import * as celo from '@/integrations/erc8004-celo';
import * as solana from '@/integrations/attestation';
import { resolveEvmKarma } from '@/lib/karma-resolver';
import type { Wallet } from '@/db/schema';
import { getAdapter } from '@/chain-adapters/registry';

const address = '0x1111111111111111111111111111111111111111';
afterEach(() => __setSupabaseForTest(null));
function store() {
  const reads: Array<{table:string;chain?:unknown}> = [];
  __setSupabaseForTest({ from(table:string) {
    const read: {table:string;chain?:unknown} = {table}; reads.push(read);
    const b: Record<string,unknown> = {};
    for (const method of ['select','in','or','order','limit','range','gte','lte','is','not']) b[method]=()=>b;
    b.eq=(key:string,value:unknown)=>{if(key==='chain')read.chain=value;return b;};
    const rows=()=>{
      if(table==='wallets')return ['arc','arc-mainnet'].filter(chain=>read.chain===undefined||chain===read.chain).map(chain=>({chain,address,provider_score:chain==='arc'?99:0,consumer_score:null,trust_tier:'Unrated',confidence_badge:'declared',tx_count:0,claimed:false}));
      if(table==='scores')return [{score:read.chain==='arc-mainnet'?12:99,calculated_at:'2026-09-12T00:00:00Z'}];
      if(table==='signal_events')return [{chain:read.chain,kind:'manifest',tier:3,face:'provider',weight:1,value:0.5,observed_at:'2026-09-12T00:00:00Z',payload:null}];
      return [];
    };
    b.single=b.maybeSingle=async()=>({data:rows()[0]??null,error:rows().length?null:{code:'PGRST116'}});
    b.then=(resolve:(v:unknown)=>void)=>resolve({data:rows(),error:null,count:rows().length});
    return b;
  }});
  return reads;
}
async function tool(name:string) {
  const response=await POST(new Request('https://agentkarma.io/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{wallet:address,chain:'arc-mainnet'}}})}));
  const text=await response.text();
  const line=text.split('\n').find(line=>line.startsWith('data:'));
  const envelope=JSON.parse(line?line.slice(5):text);
  expect(envelope.result?.isError).not.toBe(true);
  return JSON.parse(envelope.result.content[0].text);
}
test('MCP schemas accept the distinct Arc mainnet network',()=>{
  expect(chainSchema.safeParse('arc-mainnet').success).toBe(true);
  expect(chainFilterSchema.safeParse('arc-mainnet').success).toBe(true);
});
test('registry-only EVM resolver rejects an unsupported runtime mainnet input',async()=>{
  const read=spyOn(arc,'readAgent').mockRejectedValue(Error('testnet forbidden'));
  const feedback=spyOn(arc,'aggregateFeedback').mockResolvedValue({count:0,average:null,records:[]});
  try{
    expect(await resolveEvmKarma(address,'arc-mainnet' as 'arc',{chain:'arc-mainnet',address,arc_agent_id:42} as Wallet)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(feedback).not.toHaveBeenCalled();
  }finally{read.mockRestore();feedback.mockRestore();}
});
test('mainnet snapshot never calls testnet or Solana attestation readers',async()=>{
  const reads=store();
  const arcRead=spyOn(arc,'readAgent').mockRejectedValue(Error('testnet forbidden'));
  const celoRead=spyOn(celo,'readAgent').mockRejectedValue(Error('celo forbidden'));
  const solRead=spyOn(solana,'readAttestation').mockRejectedValue(Error('Solana forbidden'));
  try{
    const resolved=await resolveForChain(address,'arc-mainnet');
    expect(resolved?.kind).toBe('arc-mainnet');
    const value=fullKarmaJson(resolved!,address);
    expect(value).toMatchObject({chain:'arc-mainnet',provider:{score:null,hasSignal:false},txCount:0});
    expect(value.profileUrl).toContain('chain=arc-mainnet');
    expect(value).not.toHaveProperty('onChainAttestation');
    expect(reads.filter(r=>['transactions','signal_events','feedback'].includes(r.table)).every(r=>r.chain==='arc-mainnet')).toBe(true);
    expect(arcRead).not.toHaveBeenCalled();expect(celoRead).not.toHaveBeenCalled();expect(solRead).not.toHaveBeenCalled();
  }finally{arcRead.mockRestore();celoRead.mockRestore();solRead.mockRestore();}
});
test('MCP score history reads and links the requested network',async()=>{
  const reads=store();
  expect(await tool('get_score_history')).toMatchObject({chain:'arc-mainnet',points:[{score:12,calculatedAt:'2026-09-12T00:00:00Z'}]});
  expect(reads.find(r=>r.table==='scores')?.chain).toBe('arc-mainnet');
});
test('MCP mainnet attestations read scoped stored evidence with unavailable onchain score',async()=>{
  const reads=store();
  expect(await tool('get_attestations')).toMatchObject({chain:'arc-mainnet',erc8004:{averageScore:null},voluntary:[{kind:'manifest',tier:3}]});
  expect(reads.find(r=>r.table==='signal_events')?.chain).toBe('arc-mainnet');
});
test('the Arc-specific tool honors an explicit mainnet request without a testnet read',async()=>{
  store();
  const read=spyOn(getAdapter('arc'),'readAttestation').mockResolvedValue(99);
  try{
    expect(await tool('get_arc_karma')).toMatchObject({chain:'arc-mainnet'});
    expect(read).not.toHaveBeenCalled();
  }finally{read.mockRestore();}
});
