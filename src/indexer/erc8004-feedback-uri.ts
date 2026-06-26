/**
 * ERC-8004 feedback-comment scanner — backfills the free-text review AgentKarma
 * inlines into `feedbackURI`.
 *
 * Why a separate scan (not part of the registry scanner): ERC-8004 EMITS
 * endpoint/feedbackURI/feedbackHash in the `NewFeedback` event but does NOT
 * store them on-chain (per spec), so `readAllFeedback` — the registry scanner's
 * source — can't return them. The URI lives only in event logs. This scanner
 * reads `NewFeedback` via getLogs, decodes the inline `data:` URI, verifies its
 * keccak256 against the on-chain `feedbackHash`, and UPDATEs the matching
 * `erc8004_feedback` row's comment columns.
 *
 * Order contract: the registry scanner OWNS row existence (it INSERTs feedback
 * rows from readAllFeedback). This scanner only UPDATEs comment columns on rows
 * that already exist — so it runs AFTER the registry scan in the cron. A comment
 * therefore appears once both scans have passed its block (lag ≤ one cycle); it
 * never clobbers the registry scanner's authoritative value/revoked state.
 *
 * The cursor/window machinery mirrors arcJobsIndexer (block-number cursor,
 * <=windowSize getLogs ranges, resume from last_slot+1) — the proven shape for
 * RPCs that cap eth_getLogs ranges (Celo/Arc ≈ 10k blocks).
 */

import { createPublicClient, http, keccak256, parseAbiItem, type Log, type PublicClient } from 'viem';
import type { Chain } from '@/db/schema';
import { getRegistryConfig } from '@/config/erc8004-registries';
import {
  decodeFeedbackCommentDataUri,
  parseFeedbackComment,
} from '@/lib/feedback-comment';
import {
  getCursor as dbGetCursor,
  upsertCursor as dbUpsertCursor,
  updateFeedbackComments as dbUpdateFeedbackComments,
} from '@/db/client';

// ─── NewFeedback event (the ONLY carrier of feedbackURI/feedbackHash) ─────────
// `indexedTag1` is an indexed string → its topic is a keccak hash, never the
// plaintext; we read the non-indexed `tag1` instead and ignore `indexedTag1`.

export const NEW_FEEDBACK_EVENT = parseAbiItem(
  'event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
);

/** Celo/Arc cap eth_getLogs at 10k blocks per call. */
export const MAX_LOG_WINDOW = 10_000;

/** Bounded backfill: max windows per run (50 × 10k = 500k blocks/run). */
export const DEFAULT_MAX_WINDOWS = 50;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScannedComment {
  agentId: number;
  /** lowercased — matches the stored erc8004_feedback.client rows. */
  client: string;
  feedbackIndex: number;
  feedbackUri: string;
  feedbackHash: string;
  /** Decoded AK-schema review text, or null (non-AK URI / unparseable). */
  comment: string | null;
  /** decoded bytes keccak256 === on-chain feedbackHash (integrity proven). */
  commentVerified: boolean;
  /** Source block — lets the orchestrator rewind the cursor to retry a record
   *  whose registry row didn't exist yet (UPDATE matched 0 rows). */
  blockNumber: number;
}

/** Result of persisting a batch: how many rows matched, and which records
 *  matched nothing (their registry row isn't inserted yet → retry next run). */
export interface PersistResult {
  updated: number;
  unmatched: ScannedComment[];
}

// ─── Pure decode + verify ─────────────────────────────────────────────────────

/**
 * Decode the comment from a feedbackURI and check its integrity against the
 * on-chain hash. ONLY inline `data:` URIs are decoded (the AK-written case);
 * http/ipfs return no comment (off-chain fetch deferred). Returns no comment
 * for any URI that doesn't parse as the AK comment schema, so arbitrary
 * feedback URIs can never render as AgentKarma reviews.
 *
 * `verified` is whether keccak256(decoded bytes) matches the on-chain hash. A
 * data: URI's content is itself on-chain (in the event), so a hash mismatch
 * leaves the comment authentic-but-unproven rather than dropping it.
 */
export function decodeCommentFromUri(
  uri: string,
  onChainHash: string,
): { comment: string | null; verified: boolean } {
  const bytes = decodeFeedbackCommentDataUri(uri);
  if (!bytes) return { comment: null, verified: false };
  const parsed = parseFeedbackComment(bytes);
  if (!parsed) return { comment: null, verified: false };
  const verified = keccak256(bytes).toLowerCase() === onChainHash.toLowerCase();
  return { comment: parsed.comment, verified };
}

/**
 * Decode a raw NewFeedback log into a comment-backfill record, or null when the
 * record carries no feedbackURI (nothing to backfill). Never throws on a
 * malformed/partial log.
 */
export function parseNewFeedbackLog(
  log: Log<bigint, number, false, typeof NEW_FEEDBACK_EVENT>,
): ScannedComment | null {
  const { agentId, clientAddress, feedbackIndex, feedbackURI, feedbackHash } = log.args;
  if (agentId === undefined || !clientAddress || feedbackIndex === undefined) return null;
  if (log.blockNumber === null) return null; // pending log → no stable block to track
  if (!feedbackURI) return null; // no off-chain detail → nothing to surface
  const { comment, verified } = decodeCommentFromUri(feedbackURI, feedbackHash ?? '');
  return {
    agentId: Number(agentId),
    client: clientAddress.toLowerCase(),
    feedbackIndex: Number(feedbackIndex),
    feedbackUri: feedbackURI,
    feedbackHash: feedbackHash ?? '',
    comment,
    commentVerified: verified,
    blockNumber: Number(log.blockNumber),
  };
}

// ─── Cursor + orchestrator ────────────────────────────────────────────────────

/** Cursor key namespaced by registry so celo/arc never collide. */
export function feedbackUriCursorKey(reputationRegistry: string): string {
  return `feedback-uri:${reputationRegistry}`;
}

export interface FeedbackUriScanDeps {
  reputationRegistry: string;
  getHead: () => Promise<bigint>;
  /** Decoded, URI-bearing comment records in [fromBlock, toBlock] (inclusive). */
  getLogs: (fromBlock: bigint, toBlock: bigint) => Promise<ScannedComment[]>;
  /** UPDATE comment columns on the matching erc8004_feedback rows. Reports rows
   *  touched + the records that matched nothing (registry row not inserted yet). */
  persistComments: (rows: ScannedComment[]) => Promise<PersistResult>;
  getCursor: (key: string) => Promise<{ last_signature: string; last_slot: number | null } | null>;
  upsertCursor: (key: string, lastSignature: string, lastSlot?: number) => Promise<void>;
  windowSize?: number;
  maxWindows?: number;
  /** Genesis fallback when there's no cursor (production seeds this to the chain head → "from now"). */
  startBlock?: bigint;
}

export interface FeedbackUriScanResult {
  scanned: number;
  updated: number;
  /** Records whose registry row wasn't ready → cursor rewound to retry them. */
  retried: number;
  cursors: Map<string, string>;
}

/**
 * Scan NewFeedback events from the cursor (or startBlock) up to head in
 * <=windowSize windows, decode+verify comments, and UPDATE the matching rows.
 * Mirrors arcJobsIndexer's resume/advance/no-op semantics exactly.
 */
export async function scanFeedbackUris(deps: FeedbackUriScanDeps): Promise<FeedbackUriScanResult> {
  const cursors = new Map<string, string>();
  const windowSize = deps.windowSize ?? MAX_LOG_WINDOW;
  const maxWindows = deps.maxWindows ?? Number.POSITIVE_INFINITY;
  const key = feedbackUriCursorKey(deps.reputationRegistry);

  let startBlock = deps.startBlock ?? BigInt(0);
  const cursor = await deps.getCursor(key);
  if (cursor?.last_slot != null) startBlock = BigInt(cursor.last_slot) + BigInt(1);

  const head = await deps.getHead();
  if (startBlock > head) {
    cursors.set(key, String(head));
    return { scanned: 0, updated: 0, retried: 0, cursors };
  }

  const comments: ScannedComment[] = [];
  let maxBlock = startBlock - BigInt(1);
  let windowsProcessed = 0;

  for (let from = startBlock; from <= head; from += BigInt(windowSize)) {
    let to = from + BigInt(windowSize) - BigInt(1);
    if (to > head) to = head;
    if (to > maxBlock) maxBlock = to;

    const rows = await deps.getLogs(from, to);
    comments.push(...rows);

    if (++windowsProcessed >= maxWindows) break;
  }

  const { updated, unmatched } = comments.length > 0
    ? await deps.persistComments(comments)
    : { updated: 0, unmatched: [] as ScannedComment[] };

  // A record whose registry row isn't inserted yet matched 0 rows. DON'T advance
  // the cursor past it — rewind to just before the lowest unmatched block so the
  // next run retries it. The registry scanner (full re-read of readAllFeedback)
  // always eventually inserts the row, so this converges; without it the comment
  // would be silently lost once the cursor passed its block.
  let cursorBlock = Number(maxBlock);
  if (unmatched.length > 0) {
    const minUnmatched = Math.min(...unmatched.map((r) => r.blockNumber));
    cursorBlock = Math.min(cursorBlock, minUnmatched - 1);
  }

  await deps.upsertCursor(key, String(cursorBlock), cursorBlock);
  cursors.set(key, String(cursorBlock));
  return { scanned: comments.length, updated, retried: unmatched.length, cursors };
}

// ─── Production wiring ────────────────────────────────────────────────────────

function makeClient(chain: 'celo' | 'arc'): PublicClient {
  const config = getRegistryConfig(chain)!;
  const rpcUrl = process.env[config.rpcEnvVar];
  return createPublicClient({ chain: config.viemChain, transport: http(rpcUrl) }) as PublicClient;
}

/** Optional per-chain backfill floor; absent → scan from the current head ("from now"). */
function envStartBlock(chain: 'celo' | 'arc'): bigint | undefined {
  const raw = process.env[`${chain.toUpperCase()}_8004_FEEDBACK_START_BLOCK`];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${chain.toUpperCase()}_8004_FEEDBACK_START_BLOCK is not a non-negative integer: ${raw}`);
  return BigInt(n);
}

/**
 * Run the feedback-URI scan for a chain. With no cursor and no env floor, seeds
 * the start at the current head so only comments written from now on are
 * captured (there are no pre-feature comments to backfill) — set the env floor
 * to a past block to backfill explicitly.
 */
export async function runFeedbackUriScan(
  chain: 'celo' | 'arc',
  opts: { windowSize?: number; maxWindows?: number } = {},
): Promise<FeedbackUriScanResult> {
  const config = getRegistryConfig(chain);
  if (!config) throw new Error(`unknown EVM 8004 chain '${chain}' — known: celo, arc`);
  const client = makeClient(chain);
  const registry = config.reputationRegistry;

  const cursor = await dbGetCursor(feedbackUriCursorKey(registry), chain as Chain);
  let startBlock = envStartBlock(chain);
  if (cursor?.last_slot == null && startBlock === undefined) {
    startBlock = await client.getBlockNumber(); // fresh → from now
  }

  return scanFeedbackUris({
    reputationRegistry: registry,
    windowSize: opts.windowSize,
    maxWindows: opts.maxWindows ?? DEFAULT_MAX_WINDOWS,
    startBlock,
    getHead: () => client.getBlockNumber(),
    getLogs: async (fromBlock, toBlock) => {
      const logs = await client.getLogs({ address: registry as `0x${string}`, event: NEW_FEEDBACK_EVENT, fromBlock, toBlock });
      const out: ScannedComment[] = [];
      for (const log of logs) {
        const rec = parseNewFeedbackLog(log);
        if (rec) out.push(rec);
      }
      return out;
    },
    persistComments: (rows) => dbUpdateFeedbackComments(chain as Chain, rows),
    getCursor: async (k) => {
      const c = await dbGetCursor(k, chain as Chain);
      return c ? { last_signature: c.last_signature, last_slot: c.last_slot } : null;
    },
    upsertCursor: async (k, last, slot) => { await dbUpsertCursor(k, last, slot, chain as Chain); },
  });
}
