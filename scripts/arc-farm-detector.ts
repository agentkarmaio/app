/**
 * Arc farm-detector — scheduled observability job.
 *
 * See docs/superpowers/specs/2026-07-11-arc-farm-detector-design.md. Samples
 * three bounded signals (recent registry tokenURIs, a recent settlement
 * window, sampled agents' feedback) and judges them against fixed thresholds
 * via the pure `evaluateFarmSignals` — replacing the manual investigation
 * that produced the project_arc_registry_synthetic memory (2026-07-03/07-08).
 *
 * Alert-only: never blocks ingestion, never writes to the DB. When run inside
 * GitHub Actions (GITHUB_OUTPUT set), writes `flagged` + `summary` outputs so
 * the workflow can conditionally page via the existing telegram-alert action.
 * When run locally, just prints the report.
 *
 * Rate limiting: the public Arc Testnet RPC throttles a sequential loop hard
 * (`-32005 rate limit exceeded`) — it killed every scheduled run from
 * 2026-07-27 to 2026-08-10. Each sampled agent costs 4 eth_calls (ownerOf +
 * tokenURI + getAgentWallet + readAllFeedback), so every read goes through
 * `withRateLimitRetry` and the sample loop paces itself with PACE_MS.
 *
 * Usage: bun run scripts/arc-farm-detector.ts
 * Env: ARC_RPC_URL (optional override), ARC_FARM_DETECTOR_WINDOW_BLOCKS (default 10000, capped at 10000 — Arc's eth_getLogs limit),
 *      NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (isTemplatedCounterparty resolves agentIds from the DB)
 */

import { createPublicClient, http } from 'viem';
import { appendFileSync } from 'node:fs';
import { arcTestnet } from '../src/config/arc-chain';
import { findRegistryTip } from '../src/indexer/erc8004-registry';
import { ERC8004_REGISTRIES } from '../src/config/erc8004-registries';
import { readAgent, readAllFeedback } from '../src/integrations/erc8004-arc';
import { isTemplatedIdentity } from '../src/scoring/identity-fingerprint';
import {
  JOB_CREATED_EVENT, PAYMENT_RELEASED_EVENT, ARC_JOBS_CONTRACT, ARC_MAX_LOG_WINDOW,
  parseJobCreated, parsePaymentReleased, isTemplatedCounterparty,
} from '../src/indexer/arc-jobs';
import { evaluateFarmSignals, type FarmSamples } from '../src/scoring/farm-detector';
import { sleep, withRateLimitRetry } from '../src/lib/rpc-retry';
import { requireEnv } from '../src/lib/require-env';

const SAMPLE_SIZE = 50;
/** Pause between sampled agents so backoff is the exception, not the loop. */
const PACE_MS = Number(process.env.ARC_FARM_DETECTOR_PACE_MS ?? 250);
const WINDOW_BLOCKS = Math.min(
  ARC_MAX_LOG_WINDOW,
  Number(process.env.ARC_FARM_DETECTOR_WINDOW_BLOCKS ?? ARC_MAX_LOG_WINDOW),
);
// isTemplatedCounterparty resolves an address → arc_agent_id via the DB. Fail
// at line 1 rather than 90% into a 50-agent sample (the 2026-07-13/07-20 runs
// crashed 8 frames deep on exactly this, with no usable message).
const REQUIRED_ENV = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

async function main() {
  requireEnv(REQUIRED_ENV);
  const config = ERC8004_REGISTRIES.arc;
  const client = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });

  // ── 1. bulk-mint sample: last SAMPLE_SIZE agentIds near the registry tip ──
  const tip = await findRegistryTip(client, config.identityRegistry);
  const fromId = Math.max(1, tip - SAMPLE_SIZE + 1);
  let bulkMintTotal = 0;
  let bulkMintTemplated = 0;
  let feedbackTotal = 0;
  let feedbackAllPositive = 0;
  for (let id = fromId; id <= tip; id++) {
    if (id > fromId) await sleep(PACE_MS);
    const agent = await withRateLimitRetry(() => readAgent(id));
    if (!agent) continue;
    bulkMintTotal++;
    if (isTemplatedIdentity(agent.tokenURI)) bulkMintTemplated++;

    const feedback = await withRateLimitRetry(() => readAllFeedback(id));
    const live = feedback.filter((f) => !f.revoked);
    if (live.length > 0) {
      feedbackTotal++;
      if (live.every((f) => f.value > 0)) feedbackAllPositive++;
    }
  }

  // ── 2. settlement sample: one bounded window near the chain head ──
  const head = await withRateLimitRetry(() => client.getBlockNumber());
  const fromBlock = head > BigInt(WINDOW_BLOCKS) ? head - BigInt(WINDOW_BLOCKS) : BigInt(0);
  // Sequential, not Promise.all — two 10k-block getLogs fired together is the
  // single most reliable way to trip the limiter on the first try.
  const createdLogs = await withRateLimitRetry(() =>
    client.getLogs({ address: ARC_JOBS_CONTRACT, event: JOB_CREATED_EVENT, fromBlock, toBlock: head }),
  );
  const releasedLogs = await withRateLimitRetry(() =>
    client.getLogs({ address: ARC_JOBS_CONTRACT, event: PAYMENT_RELEASED_EVENT, fromBlock, toBlock: head }),
  );
  const clientByJob = new Map<string, string>();
  for (const log of createdLogs) {
    const rec = parseJobCreated(log);
    if (rec) clientByJob.set(rec.jobId.toString(), rec.client);
  }
  let settlementTotal = 0;
  let selfDealt = 0;
  let templatedCounterparty = 0;
  for (const log of releasedLogs) {
    const rec = parsePaymentReleased(log);
    if (!rec) continue;
    const jobClient = clientByJob.get(rec.jobId.toString());
    if (!jobClient) continue; // unmatched — same skip policy as the indexer
    settlementTotal++;
    if (jobClient.toLowerCase() === rec.provider.toLowerCase()) {
      selfDealt++;
      continue;
    }
    // One DB read + up to 3 eth_calls per settlement — the second-heaviest RPC
    // consumer in this script after the agent sample.
    if (await withRateLimitRetry(() => isTemplatedCounterparty(jobClient))) templatedCounterparty++;
  }

  const samples: FarmSamples = {
    bulkMintSample: { total: bulkMintTotal, templated: bulkMintTemplated },
    settlementSample: { total: settlementTotal, selfDealt, templated: templatedCounterparty },
    feedbackSample: { total: feedbackTotal, allPositive: feedbackAllPositive },
  };
  const report = evaluateFarmSignals(samples);

  console.log('[farm-detector] samples:', JSON.stringify(samples));
  console.log('[farm-detector] flagged:', report.flagged);
  if (report.flagged) for (const reason of report.reasons) console.log(`[farm-detector]   - ${reason}`);

  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    const summary = report.flagged
      ? `🔍 <b>AgentKarma Arc farm-detector</b>\n${report.reasons.map((r) => `• ${r}`).join('\n')}\nSampled ${bulkMintTotal} agents (ids ${fromId}-${tip}), ${settlementTotal} settlements (last ${WINDOW_BLOCKS} blocks).`
      : '';
    appendFileSync(outputPath, `flagged=${report.flagged}\n`);
    appendFileSync(outputPath, `summary<<FARM_DETECTOR_EOF\n${summary}\nFARM_DETECTOR_EOF\n`);
  }
}

await main();
