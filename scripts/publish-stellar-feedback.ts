/**
 * Publish AgentKarma metadata-quality feedback to the stellar-8004
 * Reputation Registry (mainnet). Mirrors scripts/publish-celo-feedback.ts.
 *
 * Usage:
 *   bun run scripts/publish-stellar-feedback.ts <agentId> [--execute]
 *
 * Defaults to --simulate. Pass --execute to actually send. A simulate run never
 * loads the signing key. For the scheduled, bounded, self-deduping cadence over
 * the whole eligible population, use scripts/stellar-batch-feedback.ts.
 *
 * Behavior:
 *  - Refuses to target AK's own registration (owner == AK's account) —
 *    contract blocks self-feedback anyway, but the early check is clean.
 *  - Reads the target's Identity Registry record + registration JSON
 *    (readStellarAgent: SSRF-guarded fetch, data:/https URI support).
 *  - Scores metadata quality 0-100 via the chain-agnostic v0.2 rubric
 *    (src/scoring/celo-metadata.ts — same scheme as Celo, disclosed at
 *    /validator).
 *  - Writes give_feedback tagged (agentkarma_metadata, v0.2), value = score.
 *    feedbackUri is an inline data: URI of the assessment JSON, and
 *    feedbackHash is sha256 of that SAME JSON — a verifier can decode, hash,
 *    and reconcile (parity fix precedent from publishStellarScore).
 */

import { rpc } from '@stellar/stellar-sdk';
import { readStellarAgent } from '../src/integrations/erc8004-stellar';
import { resolveStellarRpcUrl } from '../src/integrations/stellar-config';
import {
  loadStellarKeypair,
  publishStellarFeedback,
  feedbackHashFromJson,
} from '../src/integrations/erc8004-stellar-publish';
import {
  buildStellarAssessment,
  classifyTarget,
} from '../src/integrations/erc8004-stellar-attest';
import { scoreMetadataQuality } from '../src/scoring/celo-metadata';
import { AK_VALIDATOR, AK_STELLAR } from '../src/config/ak-validator';

const SCHEME_TAG1 = AK_VALIDATOR.scheme.tag1; // 'agentkarma_metadata'
const SCHEME_TAG2 = AK_VALIDATOR.scheme.tag2; // rubric version (v0.2)

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const target = args.find((a) => !a.startsWith('--'));

if (!target || !Number.isInteger(Number(target)) || Number(target) < 0) {
  console.error('usage: bun run scripts/publish-stellar-feedback.ts <agentId> [--execute]');
  process.exit(1);
}
const targetId = Number(target);

const server = new rpc.Server(resolveStellarRpcUrl(), { allowHttp: false });
// Only an actual send needs the secret; a dry run must be runnable without it.
const keypair = execute ? loadStellarKeypair() : undefined;
const akAccount = keypair?.publicKey() ?? AK_STELLAR.account;

console.log(`[1/4] resolving Stellar agent ${targetId}…`);
const agent = await readStellarAgent(server, targetId);
if (agent) {
  console.log(`    owner:    ${agent.owner}`);
  console.log(`    agentURI: ${agent.agentURI.slice(0, 96)}${agent.agentURI.length > 96 ? '…' : ''}`);
  console.log(`    name:     ${agent.registration?.name ?? '(none)'}`);
  if (agent.registrationError) console.log(`    registrationError: ${agent.registrationError}`);
}

console.log(`[2/4] scoring metadata quality…`);
const quality = agent?.registration ? scoreMetadataQuality(agent) : null;

// Same gates as the batch run (src/integrations/erc8004-stellar-attest.ts):
// refuses AK's own registration, and refuses to publish a misleading 0 when the
// metadata sits on a URI scheme our fetcher cannot resolve — that gap is ours,
// not the agent's. No score floor here: naming one agent explicitly is a
// deliberate act, and the rubric's honest low score is the point.
const verdict = classifyTarget({
  agent,
  score: quality?.score ?? null,
  akAccount,
  minScore: 0,
});
if (verdict.decision !== 'publish') {
  console.error(`✖ agent ${targetId}: ${verdict.decision} — ${verdict.reason}`);
  process.exit(1);
}

console.log(`    score:   ${quality!.score}/100`);
console.log(`    breakdown:`);
for (const [k, v] of Object.entries(quality!.breakdown)) {
  console.log(`      ${k.padEnd(20)} ${v.toString().padStart(3)}`);
}
console.log(`    notes:`);
for (const n of quality!.notes) console.log(`      • ${n}`);

const { payload, feedbackUri } = buildStellarAssessment({
  agentId: targetId,
  akAccount,
  scheme: SCHEME_TAG1,
  version: SCHEME_TAG2,
  score: quality!.score,
  breakdown: quality!.breakdown,
  notes: quality!.notes,
});
const feedbackHash = feedbackHashFromJson(payload);

console.log(`[3/4] preparing feedback record…`);
console.log(`    tag1:         ${SCHEME_TAG1}`);
console.log(`    tag2:         ${SCHEME_TAG2}`);
console.log(`    value:        ${quality!.score}`);
console.log(`    feedbackUri:  data:application/json;base64,… (${feedbackUri.length} chars)`);
console.log(`    feedbackHash: sha256:${Buffer.from(feedbackHash).toString('hex')}`);

const result = await publishStellarFeedback(
  {
    agentId: targetId,
    value: BigInt(quality!.score),
    valueDecimals: 0,
    tag1: SCHEME_TAG1,
    tag2: SCHEME_TAG2,
    endpoint: '',
    feedbackUri,
    feedbackHash,
  },
  execute ? 'execute' : 'simulate',
  { server, keypair, caller: akAccount },
);

console.log(`[4/4] ${execute ? 'executed' : 'simulated'}`);
if (result.dryRun) {
  console.log(`    simulation OK — re-run with --execute to send`);
} else {
  console.log(`    state:    ${result.state}${result.detail ? ` (${result.detail})` : ''}`);
  console.log(`    tx:       ${result.txId}`);
  console.log(`    explorer: https://stellar.expert/explorer/public/tx/${result.txId}`);
  console.log(`    8004scan: https://stellar8004.com/agents/${targetId}`);
}
