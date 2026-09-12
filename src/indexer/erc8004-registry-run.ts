/**
 * CLI: bun run src/indexer/erc8004-registry-run.ts [chain] [flags]
 *
 * Mirrors an EVM ERC-8004 IdentityRegistry + ReputationRegistry into the
 * erc8004_agents / erc8004_feedback tables so AK matches 8004scan's per-network
 * agent + feedback counts and can scan every agent.
 *
 *   chain                  celo (default) | arc
 *   --from <id>            first agentId (default 1)
 *   --to <id>              last agentId (default = discovered registry tip)
 *   --incremental         cursor-driven cheap scan for schedules: scans only NEW
 *                         ids since the last run (cursor in indexer_cursors) PLUS
 *                         a bounded recent re-scan window, so feedback added to
 *                         already-mirrored agents is still caught. Default/--full
 *                         keeps the 1..tip behavior.
 *   --full                 force the full 1..tip sweep (the default when neither
 *                         --incremental nor --from/--to is given)
 *   --rescan-window <n>    recent ids to re-scan in --incremental mode (default 500)
 *   --no-feedback          skip the ReputationRegistry pass (agents only)
 *   --no-remote            skip http/ipfs registration fetches (inline-only, fast)
 *   --identity-batch <n>   ids per identity multicall (default 250)
 *   --feedback-batch <n>   agents per feedback multicall (default 40)
 *   --dry-run              scan + log counts, NO DB writes
 *
 * Env: CELO_RPC_URL / ARC_RPC_URL (optional RPC override),
 *      NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (required unless --dry-run).
 */

import { runIndexerCli } from './managed-cli';

import { getRegistryConfig } from '@/config/erc8004-registries';
import {
  runRegistryScan,
  runIncrementalRegistryScan,
  type ScannedAgent,
  type ScannedFeedback,
} from '@/indexer/erc8004-registry';
import type { Chain } from '@/db/schema';
import { requireEnv } from '@/lib/require-env';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function numArg(name: string): number | undefined {
  const v = arg(name);
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

const chain = (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'celo');
const config = getRegistryConfig(chain);
if (!config) {
  console.error(`unknown chain '${chain}' — known EVM 8004 registries: celo, arc`);
  process.exit(1);
}

const dryRun = flag('dry-run');
const incremental = flag('incremental');
const scanFeedback = !flag('no-feedback');
const fetchRemote = !flag('no-remote');

if (incremental && dryRun) {
  console.error('[registry] --incremental needs the DB cursor and is incompatible with --dry-run');
  process.exit(1);
}

console.log(`[registry] chain=${chain} identity=${config.identityRegistry} reputation=${config.reputationRegistry}`);
console.log(`[registry] mode=${dryRun ? 'DRY-RUN (no writes)' : 'WRITE'} scan=${incremental ? 'INCREMENTAL' : 'FULL'} feedback=${scanFeedback} remote=${fetchRemote}`);

// Persist callbacks. --dry-run swaps in no-op counters so the scan exercises the
// full read path (incl. RPC + decode) without touching the DB.
let persistAgents: (chain: string, agents: ScannedAgent[]) => Promise<number>;
let persistFeedback: (chain: string, fb: ScannedFeedback[]) => Promise<number>;

const fromId = numArg('from');
const sharedOpts = {
  identityBatch: numArg('identity-batch'),
  feedbackBatch: numArg('feedback-batch'),
  fetchRemote,
  scanFeedback,
  onProgress: (m: string) => console.log(`[registry] ${m}`),
};

const start = Date.now();
const execution = await runIndexerCli({
  chain: chain as Chain, path: 'registry', dryRun,
  run: async (signal) => {
    let scanned;

    if (dryRun) {
      persistAgents = async (_c, a) => a.length;
      persistFeedback = async (_c, f) => f.length;
      scanned = await runRegistryScan(config, persistAgents, persistFeedback, {
        ...sharedOpts, signal,
        fromId,
        toId: numArg('to'),
      });
    } else {
      // Fail loudly at line 1 if DB secrets are unset (GitHub injects unset secrets
      // as empty strings) — same preflight as keep-fresh/heartbeat so a scheduled
      // run can't sail past checkout and crash deep in the write path unnoticed.
      requireEnv(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
      const db = await import('@/db/client');
      persistAgents = db.upsertErc8004Agents;
      persistFeedback = db.upsertErc8004Feedback;
      if (incremental) {
        scanned = await runIncrementalRegistryScan(
          config,
          persistAgents,
          persistFeedback,
          (c) => db.getRegistryCursorTip(c as Chain),
          (c, tip) => db.setRegistryCursorTip(c as Chain, tip),
          { ...sharedOpts, signal, rescanWindow: numArg('rescan-window') },
        );
      } else {
        scanned = await runRegistryScan(config, persistAgents, persistFeedback, {
          ...sharedOpts, signal,
          fromId,
          toId: numArg('to'),
        });
      }
    }
    signal?.throwIfAborted();
    return scanned;
  },
  summarize: (r) => {
    // Explicit subranges remain partial evidence for the chain-level path.
    const partial = !incremental && (fromId !== undefined || numArg('to') !== undefined);
    return { status: r.errors ? 'failed' : partial ? 'catching_up' : 'caught_up',
      errorCode: r.errors || partial ? 'scan_partial' : undefined,
      checkedCount: r.agentsScanned, insertedCount: r.agentsPersisted, unresolvedCount: r.errors,
      checkpoint: r.errors ? undefined : String(r.tip), head: String(r.tip) };
  },
});
if (!execution.result) {
  console.log(`[registry] ${execution.status}${execution.errorCode ? ` (${execution.errorCode})` : ''} — no scan result`);
  process.exit(execution.exitCode);
}
const result = execution.result;
console.log(`[registry] managed status: ${execution.status}`);

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log('');
console.log('─── registry scan summary ──────────────────────────────');
console.log(`chain:               ${result.chain}`);
console.log(`registry tip:        ${result.tip}`);
console.log(`agents scanned:      ${result.agentsScanned}`);
console.log(`agents persisted:    ${result.agentsPersisted}`);
console.log(`feedback scanned:    ${result.feedbackScanned}`);
console.log(`feedback persisted:  ${result.feedbackPersisted}`);
console.log(`errors:              ${result.errors}`);
console.log(`elapsed:             ${elapsed}s`);
process.exit(execution.exitCode);
