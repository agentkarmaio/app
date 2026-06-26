/**
 * CLI: bun run src/indexer/erc8004-feedback-uri-run.ts [chain] [flags]
 *
 * Backfills ERC-8004 feedback COMMENTS — the free-text review AgentKarma inlines
 * into a NewFeedback event's feedbackURI. readAllFeedback (the registry scanner's
 * source) can't return the URI; only the event carries it. This run scans
 * NewFeedback via getLogs, decodes + keccak-verifies the inline data: URI, and
 * UPDATEs the matching erc8004_feedback rows' comment columns.
 *
 *   chain                celo (default) | arc
 *   --window <n>         blocks per getLogs call (default 10000 — the Celo/Arc cap)
 *   --max-windows <n>    windows per run (default 50; bounds a deep backfill)
 *   --dry-run            scan + log counts, NO DB writes
 *
 * ORDER: run this AFTER `registry:scan` for the same chain — the registry scan
 * INSERTs the feedback rows this UPDATE-only pass fills. A fresh run with no
 * cursor starts at the current head ("from now"); set
 * <CHAIN>_8004_FEEDBACK_START_BLOCK to a past block to backfill historical URIs.
 *
 * Env: CELO_RPC_URL / ARC_RPC_URL (optional RPC override),
 *      NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (required unless --dry-run).
 */

import { getRegistryConfig } from '@/config/erc8004-registries';
import {
  scanFeedbackUris,
  feedbackUriCursorKey,
  parseNewFeedbackLog,
  NEW_FEEDBACK_EVENT,
  DEFAULT_MAX_WINDOWS,
  MAX_LOG_WINDOW,
  type ScannedComment,
  type PersistResult,
} from '@/indexer/erc8004-feedback-uri';
import { createPublicClient, http, type PublicClient } from 'viem';

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

const chainArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'celo';
const config = getRegistryConfig(chainArg);
if (!config) {
  console.error(`unknown chain '${chainArg}' — known EVM 8004 registries: celo, arc`);
  process.exit(1);
}
const chain = config.chain;
const dryRun = flag('dry-run');
const windowSize = numArg('window') ?? MAX_LOG_WINDOW;
const maxWindows = numArg('max-windows') ?? DEFAULT_MAX_WINDOWS;

console.log(`[feedback-uri] chain=${chain} reputation=${config.reputationRegistry}`);
console.log(`[feedback-uri] mode=${dryRun ? 'DRY-RUN (no writes)' : 'WRITE'} window=${windowSize} maxWindows=${maxWindows}`);

const client = createPublicClient({
  chain: config.viemChain,
  transport: http(process.env[config.rpcEnvVar]),
}) as PublicClient;

const registry = config.reputationRegistry;
const cursorKey = feedbackUriCursorKey(registry);

async function getLogs(fromBlock: bigint, toBlock: bigint): Promise<ScannedComment[]> {
  const logs = await client.getLogs({ address: registry as `0x${string}`, event: NEW_FEEDBACK_EVENT, fromBlock, toBlock });
  const out: ScannedComment[] = [];
  for (const log of logs) {
    const rec = parseNewFeedbackLog(log);
    if (rec) out.push(rec);
  }
  return out;
}

const start = Date.now();

// In-memory cursor for --dry-run so the scan exercises the full read path without
// touching the DB; real persistence is the db client's cursor + UPDATE helpers.
const memCursor = new Map<string, { last_signature: string; last_slot: number | null }>();

let getCursor: (key: string) => Promise<{ last_signature: string; last_slot: number | null } | null>;
let upsertCursor: (key: string, last: string, slot?: number) => Promise<void>;
let persistComments: (rows: ScannedComment[]) => Promise<PersistResult>;

if (dryRun) {
  getCursor = async (k) => memCursor.get(k) ?? null;
  upsertCursor = async (k, last, slot) => { memCursor.set(k, { last_signature: last, last_slot: slot ?? null }); };
  persistComments = async (rows) => ({ updated: rows.length, unmatched: [] });
} else {
  const db = await import('@/db/client');
  getCursor = async (k) => {
    const c = await db.getCursor(k, chain);
    return c ? { last_signature: c.last_signature, last_slot: c.last_slot } : null;
  };
  upsertCursor = async (k, last, slot) => { await db.upsertCursor(k, last, slot, chain); };
  persistComments = (rows) => db.updateFeedbackComments(chain, rows);
}

// Seed a fresh (no-cursor) run at the current head — there are no pre-feature
// comments to backfill, so "from now" is the right default. Env floor overrides.
let startBlock: bigint | undefined;
const envFloor = process.env[`${chain.toUpperCase()}_8004_FEEDBACK_START_BLOCK`];
if (envFloor) startBlock = BigInt(Number.parseInt(envFloor, 10));
const existing = await getCursor(cursorKey);
if (existing?.last_slot == null && startBlock === undefined) {
  startBlock = await client.getBlockNumber();
  console.log(`[feedback-uri] fresh scan — seeding from head block ${startBlock}`);
}

const result = await scanFeedbackUris({
  reputationRegistry: registry,
  windowSize,
  maxWindows,
  startBlock,
  getHead: () => client.getBlockNumber(),
  getLogs,
  persistComments,
  getCursor,
  upsertCursor,
});

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log('');
console.log('─── feedback-uri scan summary ──────────────────────────');
console.log(`chain:               ${chain}`);
console.log(`comments scanned:    ${result.scanned}`);
console.log(`rows updated:        ${result.updated}`);
console.log(`deferred (retry):    ${result.retried}${result.retried > 0 ? ' — registry row not inserted yet, cursor rewound' : ''}`);
console.log(`cursor:              ${result.cursors.get(cursorKey) ?? '(unchanged)'}`);
console.log(`elapsed:             ${elapsed}s`);
process.exit(0);
