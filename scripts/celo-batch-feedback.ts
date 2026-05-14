/**
 * Batch metadata-quality feedback to Celo ReputationRegistry.
 *
 * Iterates a range of agentIds, computes each agent's metadata-quality score
 * (0-100, see src/scoring/celo-metadata.ts), and writes a feedback record
 * ONLY if the score clears the threshold. Skips AK itself, skips agents AK
 * has already rated, skips agents whose registration JSON can't be resolved.
 *
 * Positive-bias on purpose: low-score broadcast hurts agents that may just
 * have an off-chain hosting issue. Below-threshold agents simply get no AK
 * rating — silence is not a negative signal in our scheme.
 *
 * Usage:
 *   bun run scripts/celo-batch-feedback.ts --from 2 --to 30 [--min 70] [--execute]
 *
 * Defaults to --simulate. Pass --execute to actually send.
 */

import { readAgent, readAllFeedback } from '../src/integrations/erc8004-celo';
import { scoreMetadataQuality } from '../src/scoring/celo-metadata';
import {
  publishFeedback,
  feedbackHashFromJson,
} from '../src/integrations/erc8004-celo-publish';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const AK_AGENT_ID = BigInt(9058);

const { address: AK_OWNER } = JSON.parse(
  readFileSync(resolve('.keys/agentkarma-celo.json'), 'utf-8'),
) as { address: `0x${string}` };
const AK_OWNER_LC = AK_OWNER.toLowerCase();

function argFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function argVal(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

const from = Number(argVal('from', '2'));
const to = Number(argVal('to', '30'));
const minScore = Number(argVal('min', '70'));
const execute = argFlag('execute');

if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
  console.error('usage: --from <int> --to <int> [--min <int>] [--execute]');
  process.exit(1);
}

console.log(`AK validator: ${AK_OWNER}`);
console.log(`range: agentId ${from}..${to}`);
console.log(`min score: ${minScore}`);
console.log(`mode: ${execute ? 'EXECUTE' : 'simulate'}`);
console.log('');

interface Outcome {
  agentId: number;
  decision: 'rated' | 'already_rated' | 'unresolved' | 'below_threshold' | 'skipped_self' | 'error';
  score?: number;
  txHash?: string;
  detail?: string;
}

const outcomes: Outcome[] = [];

for (let id = from; id <= to; id++) {
  const agentId = BigInt(id);
  process.stdout.write(`  agent ${String(id).padStart(4)}: `);

  if (agentId === AK_AGENT_ID) {
    console.log('skip (AK self)');
    outcomes.push({ agentId: id, decision: 'skipped_self' });
    continue;
  }

  try {
    const agent = await readAgent(agentId);
    if (!agent) {
      console.log('not registered');
      outcomes.push({ agentId: id, decision: 'unresolved', detail: 'no agent' });
      continue;
    }

    const quality = scoreMetadataQuality(agent);
    if (quality.score < minScore) {
      console.log(`score ${quality.score} < ${minScore} → skip`);
      outcomes.push({ agentId: id, decision: 'below_threshold', score: quality.score });
      continue;
    }

    // Skip if AK already rated this agent under our scheme.
    const allFb = await readAllFeedback(agentId, {
      tag1: 'agentkarma_metadata',
      tag2: 'v0.1',
    }).catch(() => []);
    const akRated = allFb.some((r) => r.client.toLowerCase() === AK_OWNER_LC && !r.revoked);
    if (akRated) {
      console.log(`already rated`);
      outcomes.push({ agentId: id, decision: 'already_rated', score: quality.score });
      continue;
    }

    // Build feedback record + assessment payload.
    const assessment = {
      rater: 'AgentKarma',
      raterAgentId: AK_AGENT_ID.toString(),
      target: agentId.toString(),
      scheme: 'agentkarma_metadata',
      version: 'v0.1',
      score: quality.score,
      breakdown: quality.breakdown,
      notes: quality.notes,
      generatedAt: new Date().toISOString(),
    };

    const result = await publishFeedback(
      {
        agentId,
        value: quality.score,
        valueDecimals: 0,
        tag1: 'agentkarma_metadata',
        tag2: 'v0.1',
        endpoint: '',
        feedbackURI: `https://agentkarma.io/api/v2/celo/${id}`,
        feedbackHash: feedbackHashFromJson(assessment),
      },
      execute ? 'execute' : 'simulate',
    );

    if (result.dryRun) {
      console.log(`score ${quality.score} → would rate (gas ${result.estimatedCostCelo} CELO)`);
      outcomes.push({ agentId: id, decision: 'rated', score: quality.score });
    } else {
      console.log(`score ${quality.score} → tx ${result.txHash?.slice(0, 10)}…`);
      outcomes.push({
        agentId: id,
        decision: 'rated',
        score: quality.score,
        txHash: result.txHash,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`error: ${msg.slice(0, 60)}`);
    outcomes.push({ agentId: id, decision: 'error', detail: msg });
  }
}

console.log('');
console.log('────────────────  summary  ────────────────');
const grouped: Record<string, number> = {};
for (const o of outcomes) {
  grouped[o.decision] = (grouped[o.decision] ?? 0) + 1;
}
for (const [k, v] of Object.entries(grouped)) {
  console.log(`  ${k.padEnd(20)} ${v}`);
}

const ratedIds = outcomes.filter((o) => o.decision === 'rated').map((o) => o.agentId);
if (ratedIds.length > 0) {
  console.log('');
  console.log(`${execute ? 'rated' : 'would rate'}: ${ratedIds.join(', ')}`);
}

if (!execute) {
  console.log('');
  console.log('--simulate mode: nothing sent. Re-run with --execute to write feedback.');
}
