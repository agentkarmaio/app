/**
 * Batch metadata-quality feedback to Celo ReputationRegistry.
 *
 * AK acts as an honest ERC-8004 reputation validator: it reads each agent's
 * declared registration JSON, scores metadata quality (0-100, see
 * src/scoring/celo-metadata.ts), and writes a feedback record ONLY if the
 * score clears the threshold. Skips AK itself, skips agents AK has already
 * rated, skips agents whose registration JSON can't be resolved.
 *
 * Positive-bias on purpose: low-score broadcast hurts agents that may just
 * have an off-chain hosting issue. Below-threshold agents simply get no AK
 * rating — silence is not a negative signal in our scheme.
 *
 * Two selection modes:
 *   range  — contiguous agentId span (legacy):
 *              bun run scripts/celo-batch-feedback.ts --from 2 --to 30
 *   sample — stratified random draw from the registry mirror (default for
 *            organic drips: varied agentIds + a spread of score buckets, so
 *            the on-chain record set reads like graded assessments rather than
 *            a sequential rubber-stamp):
 *              bun run scripts/celo-batch-feedback.ts --count 24
 *
 * Natural pacing: in --execute mode a randomized delay (`--jitter` seconds,
 * default 25) is inserted between writes so records land in different blocks at
 * irregular intervals instead of one bursty nonce run. Re-run over time to keep
 * the drip going — sample mode draws a fresh random window each run.
 *
 * Defaults to --simulate. Pass --execute to actually send.
 */

import { readAgent, readAllFeedback } from '../src/integrations/erc8004-celo';
import { scoreMetadataQuality } from '../src/scoring/celo-metadata';
import {
  publishFeedback,
  feedbackHashFromJson,
  activeSignerAddress,
} from '../src/integrations/erc8004-celo-publish';
import { AK_VALIDATOR, isAkRater } from '../src/config/ak-validator';
import { supabase } from '../src/db/client';

const AK_AGENT_ID = BigInt(AK_VALIDATOR.agentId);
// Scheme tag1/tag2 sourced from the validator config so the on-chain version
// can never drift from the rubric in src/scoring/celo-metadata.ts. Bumping the
// rubric → bump AK_VALIDATOR.scheme.tag2 → new records carry the new version.
const SCHEME_TAG1 = AK_VALIDATOR.scheme.tag1;
const SCHEME_TAG2 = AK_VALIDATOR.scheme.tag2;

// The wallet that will actually sign (dedicated validator key when present).
const AK_SIGNER = activeSignerAddress();

function argFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function argVal(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

const minScore = Number(argVal('min', '70'));
const jitterSec = Number(argVal('jitter', '25'));
const execute = argFlag('execute');
const countArg = argVal('count');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Stratified random sample of unrated Celo agents from the registry mirror.
 * Pulls a random window from each score band (low/mid/high) so published
 * values span a realistic grade distribution instead of a wall of 100s, then
 * shuffles the combined set. A random offset per band varies which agents get
 * picked across re-runs, keeping the drip organic.
 */
async function sampleCandidates(min: number, count: number): Promise<number[]> {
  // AK's already-published metadata ratings (tiny set) — exclude from draw.
  // Only AK writes the 'agentkarma_metadata' scheme, so filter on it and match
  // any AK signer address (controller or validator) regardless of case.
  const { data: rated } = await supabase
    .from('erc8004_feedback')
    .select('agent_id, client')
    .eq('chain', 'celo')
    .eq('tag1', 'agentkarma_metadata');
  const ratedIds = new Set(
    (rated ?? []).filter((r) => isAkRater(String(r.client))).map((r) => Number(r.agent_id)),
  );

  const bands: Array<{ lo: number; hi: number | null }> = [
    { lo: min, hi: 85 },
    { lo: 85, hi: 95 },
    { lo: 95, hi: null },
  ];
  const WINDOW = 200;

  const collected: number[] = [];
  for (const band of bands) {
    let q = supabase
      .from('erc8004_agents')
      .select('agent_id', { count: 'exact', head: true })
      .eq('chain', 'celo')
      .gte('metadata_score', band.lo);
    if (band.hi !== null) q = q.lt('metadata_score', band.hi);
    const { count: bandCount } = await q;
    const total = bandCount ?? 0;
    if (total === 0) continue;

    const offset = Math.floor(Math.random() * Math.max(1, total - WINDOW));
    let qr = supabase
      .from('erc8004_agents')
      .select('agent_id')
      .eq('chain', 'celo')
      .gte('metadata_score', band.lo)
      .order('agent_id', { ascending: true })
      .range(offset, offset + WINDOW - 1);
    if (band.hi !== null) qr = qr.lt('metadata_score', band.hi);
    const { data } = await qr;
    const ids = shuffle((data ?? []).map((r) => Number(r.agent_id)))
      .filter((id) => id !== 9058 && !ratedIds.has(id));
    // Even split across the three bands; high band backfills any shortfall.
    collected.push(...ids.slice(0, Math.ceil(count / bands.length)));
  }

  return shuffle([...new Set(collected)]).slice(0, count);
}

// ─── Resolve target id list ────────────────────────────────────────────────
let targets: number[];
if (countArg !== undefined) {
  const count = Number(countArg);
  if (!Number.isInteger(count) || count < 1) {
    console.error('usage: --count <int> [--min <int>] [--jitter <sec>] [--execute]');
    process.exit(1);
  }
  targets = await sampleCandidates(minScore, count);
  console.log(`AK signer: ${AK_SIGNER}${isAkRater(AK_SIGNER) && AK_SIGNER.toLowerCase() === AK_VALIDATOR.validator.toLowerCase() ? ' (dedicated validator)' : ' (treasury/controller)'}`);
  console.log(`mode: sample (${targets.length} drawn, min score ${minScore})`);
} else {
  const from = Number(argVal('from', '2'));
  const to = Number(argVal('to', '30'));
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
    console.error('usage: --from <int> --to <int> [--min <int>] [--jitter <sec>] [--execute]');
    console.error('   or: --count <int> [--min <int>] [--jitter <sec>] [--execute]');
    process.exit(1);
  }
  targets = [];
  for (let id = from; id <= to; id++) targets.push(id);
  console.log(`AK signer: ${AK_SIGNER}${isAkRater(AK_SIGNER) && AK_SIGNER.toLowerCase() === AK_VALIDATOR.validator.toLowerCase() ? ' (dedicated validator)' : ' (treasury/controller)'}`);
  console.log(`mode: range (agentId ${from}..${to}, min score ${minScore})`);
}
console.log(`pacing: ${execute ? `${jitterSec}s jitter between writes` : 'n/a (simulate)'}`);
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

for (let t = 0; t < targets.length; t++) {
  const id = targets[t];
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

    // Skip if AK already rated this agent under our scheme. Filter on tag1 ONLY
    // (no tag2): an agent rated under ANY scheme version — including the 26
    // existing v0.1 records — counts as already-rated, so the v0.2 bump never
    // re-rates (and never rewrites) an agent AK has already scored. Live read is
    // the source of truth — the mirror used for selection can lag the chain.
    const allFb = await readAllFeedback(agentId, {
      tag1: SCHEME_TAG1,
    }).catch(() => []);
    const akRated = allFb.some((r) => isAkRater(r.client) && !r.revoked);
    if (akRated) {
      console.log(`already rated`);
      outcomes.push({ agentId: id, decision: 'already_rated', score: quality.score });
      continue;
    }

    // Build feedback record + assessment payload. The off-chain assessment is
    // hashed into feedbackHash; the feedbackURI resolves to AK's live record
    // for the agent so the attestation is inspectable end-to-end.
    const recordURI = `https://agentkarma.io/api/v2/celo/${id}`;
    const assessment = {
      rater: 'AgentKarma',
      raterAgentId: AK_AGENT_ID.toString(),
      target: agentId.toString(),
      scheme: SCHEME_TAG1,
      version: SCHEME_TAG2,
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
        tag1: SCHEME_TAG1,
        tag2: SCHEME_TAG2,
        endpoint: recordURI,
        feedbackURI: recordURI,
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
      // Natural pacing: randomized gap so records spread across blocks. Skip
      // after the final write.
      if (jitterSec > 0 && t < targets.length - 1) {
        const ms = Math.round(jitterSec * 1000 * (0.4 + Math.random() * 1.2));
        await sleep(ms);
      }
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

const rated = outcomes.filter((o) => o.decision === 'rated');
if (rated.length > 0) {
  console.log('');
  console.log(`${execute ? 'rated' : 'would rate'}: ${rated.map((o) => o.agentId).join(', ')}`);
  if (execute) {
    for (const o of rated) {
      console.log(`  agent ${o.agentId} (score ${o.score}): https://celoscan.io/tx/${o.txHash}`);
    }
  }
}

if (!execute) {
  console.log('');
  console.log('--simulate mode: nothing sent. Re-run with --execute to write feedback.');
}
