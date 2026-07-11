/**
 * Read-only: candidate-pool stats for AK's Celo metadata-feedback campaign.
 * Reports total Celo agents, metadata-score distribution, how many AK has
 * already rated under ('agentkarma_metadata','v0.1'), and agentId range.
 *
 * Scratch script — safe to delete. No writes.
 */
import { supabase } from '../src/db/client';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const { address: AK } = JSON.parse(
  readFileSync(resolve('.keys/agentkarma-celo.json'), 'utf-8'),
) as { address: `0x${string}` };

async function count(filter: (q: any) => any): Promise<number> {
  const base = supabase.from('erc8004_agents').select('*', { count: 'exact', head: true }).eq('chain', 'celo');
  const { count } = await filter(base);
  return count ?? 0;
}

const total = await count((q) => q);
const ge90 = await count((q) => q.gte('metadata_score', 90));
const ge80 = await count((q) => q.gte('metadata_score', 80));
const ge70 = await count((q) => q.gte('metadata_score', 70));
const ge50 = await count((q) => q.gte('metadata_score', 50));

const { data: range } = await supabase
  .from('erc8004_agents').select('agent_id').eq('chain', 'celo')
  .order('agent_id', { ascending: true });
const ids = (range ?? []).map((r: any) => Number(r.agent_id));
const minId = ids[0];
const maxId = ids[ids.length - 1];

// AK's already-published metadata feedback (on-chain, mirrored)
const { data: akFb, count: akCount } = await supabase
  .from('erc8004_feedback').select('agent_id', { count: 'exact' })
  .eq('chain', 'celo').ilike('client', AK).eq('tag1', 'agentkarma_metadata');
const ratedIds = new Set((akFb ?? []).map((r: any) => Number(r.agent_id)));

// Candidates: score >=70, not already rated by AK, not AK itself (9058)
const { data: candRows } = await supabase
  .from('erc8004_agents').select('agent_id,metadata_score')
  .eq('chain', 'celo').gte('metadata_score', 70).order('metadata_score', { ascending: false });
const candidates = (candRows ?? [])
  .map((r: any) => ({ id: Number(r.agent_id), score: r.metadata_score }))
  .filter((c) => c.id !== 9058 && !ratedIds.has(c.id));

console.log('AK validator:', AK);
console.log('─── Celo erc8004_agents mirror ───');
console.log('total agents       :', total);
console.log('agentId range      :', minId, '..', maxId);
console.log('score >=90         :', ge90);
console.log('score >=80         :', ge80);
console.log('score >=70         :', ge70);
console.log('score >=50         :', ge50);
console.log('─── AK feedback already published ───');
console.log('AK metadata records:', akCount ?? 0, '(rated ids:', [...ratedIds].sort((a, b) => a - b).join(', ') || '(none)', ')');
console.log('─── Fresh candidates (score>=70, unrated) ───');
console.log('count              :', candidates.length);
console.log('sample (id:score)  :', candidates.slice(0, 40).map((c) => `${c.id}:${c.score}`).join('  '));
