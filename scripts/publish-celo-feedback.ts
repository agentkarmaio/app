/**
 * Publish AgentKarma metadata-quality feedback to Celo ReputationRegistry.
 *
 * Usage:
 *   bun run scripts/publish-celo-feedback.ts <agentId> [--execute]
 *
 * Defaults to --simulate. Pass --execute to actually send.
 *
 * Behavior:
 *  - Refuses to target AK's own agent (9058) — contract blocks self-feedback
 *    anyway, but the early check gives a clean error.
 *  - Fetches the target's IdentityRegistry record + registration JSON.
 *  - Scores metadata quality 0-100 via src/scoring/celo-metadata.ts.
 *  - Writes a feedback record tagged ('agentkarma_metadata', 'v0.1') with
 *    integer value = the metadata-quality score.
 */

import { readAgent } from '../src/integrations/erc8004-celo';
import { scoreMetadataQuality } from '../src/scoring/celo-metadata';
import { publishFeedback, feedbackHashFromJson } from '../src/integrations/erc8004-celo-publish';

const AK_AGENT_ID = BigInt(9058);

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const target = args.find((a) => !a.startsWith('--'));

if (!target) {
  console.error('usage: bun run scripts/publish-celo-feedback.ts <agentId> [--execute]');
  process.exit(1);
}

const targetId = BigInt(target);
if (targetId === AK_AGENT_ID) {
  console.error('✖ cannot rate AK itself (agentId 9058). Pick a different target.');
  process.exit(1);
}

console.log(`[1/4] resolving Celo agent ${targetId}…`);
const agent = await readAgent(targetId);
if (!agent) {
  console.error(`✖ no agent registered with id ${targetId} on Celo`);
  process.exit(1);
}
console.log(`    owner:   ${agent.owner}`);
console.log(`    tokenURI:${agent.tokenURI}`);
console.log(`    name:    ${agent.registration?.name ?? '(none)'}`);

console.log(`[2/4] scoring metadata quality…`);
const quality = scoreMetadataQuality(agent);
console.log(`    score:   ${quality.score}/100`);
console.log(`    breakdown:`);
for (const [k, v] of Object.entries(quality.breakdown)) {
  console.log(`      ${k.padEnd(20)} ${v.toString().padStart(3)}`);
}
console.log(`    notes:`);
for (const n of quality.notes) console.log(`      • ${n}`);

const assessmentPayload = {
  rater: 'AgentKarma',
  raterAgentId: AK_AGENT_ID.toString(),
  target: targetId.toString(),
  scheme: 'agentkarma_metadata',
  version: 'v0.1',
  score: quality.score,
  breakdown: quality.breakdown,
  notes: quality.notes,
  generatedAt: new Date().toISOString(),
};

const feedbackURI = `https://agentkarma.io/api/v2/celo/${targetId}`;
const feedbackHash = feedbackHashFromJson(assessmentPayload);

console.log(`[3/4] preparing feedback record…`);
console.log(`    tag1:         agentkarma_metadata`);
console.log(`    tag2:         v0.1`);
console.log(`    value:        ${quality.score}`);
console.log(`    feedbackURI:  ${feedbackURI}`);
console.log(`    feedbackHash: ${feedbackHash}`);

const result = await publishFeedback(
  {
    agentId: targetId,
    value: quality.score,
    valueDecimals: 0,
    tag1: 'agentkarma_metadata',
    tag2: 'v0.1',
    endpoint: '',
    feedbackURI,
    feedbackHash,
  },
  execute ? 'execute' : 'simulate',
);

console.log(`[4/4] ${execute ? 'executed' : 'simulated'}`);
if (result.dryRun) {
  console.log(`    estimated gas: ${result.gasUsed}`);
  console.log(`    estimated cost: ${result.estimatedCostCelo} CELO`);
  console.log(`    re-run with --execute to send`);
} else {
  console.log(`    tx:    ${result.txHash}`);
  console.log(`    block: ${result.block}`);
  console.log(`    gas:   ${result.gasUsed}`);
  console.log(`    explorer: https://celoscan.io/tx/${result.txHash}`);
  console.log(`    8004scan: https://8004scan.io/agent/${targetId}`);
}
