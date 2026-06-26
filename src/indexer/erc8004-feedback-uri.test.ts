/// <reference types="bun-types" />
/**
 * erc8004-feedback-uri scanner — backfills feedbackURI/feedbackHash + the
 * decoded, integrity-verified comment from NewFeedback events (the only place
 * ERC-8004 carries them; readAllFeedback can't). Two risk surfaces:
 *   1. decodeCommentFromUri — verifying an UNTRUSTED on-chain data URI against
 *      its on-chain keccak hash, and refusing non-AK-schema payloads.
 *   2. the cursor/window orchestrator — must mirror arcJobsIndexer's
 *      resume/advance semantics so no block is double-scanned or skipped.
 */
import { describe, expect, test } from 'bun:test';
import { keccak256 } from 'viem';
import {
  buildFeedbackCommentBytes,
  encodeFeedbackCommentDataUri,
} from '@/lib/feedback-comment';
import {
  decodeCommentFromUri,
  scanFeedbackUris,
  feedbackUriCursorKey,
  type ScannedComment,
  type FeedbackUriScanDeps,
} from './erc8004-feedback-uri';

function akDataUri(value: number, comment: string, stars?: number): { uri: string; hash: `0x${string}` } {
  const bytes = buildFeedbackCommentBytes({ value, stars, comment });
  return { uri: encodeFeedbackCommentDataUri(bytes), hash: keccak256(bytes) };
}

describe('decodeCommentFromUri', () => {
  test('AK data URI with matching hash → verified comment', () => {
    const { uri, hash } = akDataUri(100, 'excellent agent', 5);
    expect(decodeCommentFromUri(uri, hash)).toEqual({ comment: 'excellent agent', verified: true });
  });

  test('AK data URI with wrong on-chain hash → comment kept, unverified', () => {
    const { uri } = akDataUri(100, 'still authentic, just unproven');
    const r = decodeCommentFromUri(uri, `0x${'1'.repeat(64)}`);
    expect(r.comment).toBe('still authentic, just unproven');
    expect(r.verified).toBe(false);
  });

  test('hash comparison is case-insensitive', () => {
    const { uri, hash } = akDataUri(80, 'case test');
    expect(decodeCommentFromUri(uri, hash.toUpperCase().replace('0X', '0x') as `0x${string}`).verified).toBe(true);
  });

  test('data URI that is valid JSON but NOT the AK schema → no comment', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ schema: 'other/v1', value: 1, comment: 'nope' }));
    const uri = `data:application/json;base64,${Buffer.from(bytes).toString('base64')}`;
    expect(decodeCommentFromUri(uri, keccak256(bytes))).toEqual({ comment: null, verified: false });
  });

  test('http/ipfs URI → no comment (off-chain fetch deferred)', () => {
    expect(decodeCommentFromUri('https://example.com/f.json', `0x${'0'.repeat(64)}`)).toEqual({ comment: null, verified: false });
    expect(decodeCommentFromUri('ipfs://Qm', `0x${'0'.repeat(64)}`)).toEqual({ comment: null, verified: false });
  });

  test('empty URI → no comment', () => {
    expect(decodeCommentFromUri('', `0x${'0'.repeat(64)}`)).toEqual({ comment: null, verified: false });
  });
});

describe('feedbackUriCursorKey', () => {
  test('namespaces by registry so celo/arc never collide', () => {
    expect(feedbackUriCursorKey('0xAAA')).toBe('feedback-uri:0xAAA');
    expect(feedbackUriCursorKey('0xBBB')).not.toBe(feedbackUriCursorKey('0xAAA'));
  });
});

// ── Orchestrator (DI core over decoded records) ───────────────────────────────

function makeDeps(overrides: Partial<FeedbackUriScanDeps> & { logsByWindow?: ScannedComment[][] } = {}) {
  const persisted: ScannedComment[] = [];
  const cursors = new Map<string, { last_signature: string; last_slot: number | null }>();
  const windows: Array<[bigint, bigint]> = [];
  const logsByWindow = overrides.logsByWindow ?? [];
  let windowIdx = 0;

  const deps: FeedbackUriScanDeps = {
    reputationRegistry: '0xREG',
    getHead: overrides.getHead ?? (async () => BigInt(25_000)),
    getLogs: overrides.getLogs ?? (async (from, to) => {
      windows.push([from, to]);
      return logsByWindow[windowIdx++] ?? [];
    }),
    persistComments: overrides.persistComments ?? (async (rows) => { persisted.push(...rows); return { updated: rows.length, unmatched: [] }; }),
    getCursor: overrides.getCursor ?? (async (key) => cursors.get(key) ?? null),
    upsertCursor: overrides.upsertCursor ?? (async (key, sig, slot) => { cursors.set(key, { last_signature: sig, last_slot: slot ?? null }); }),
    windowSize: overrides.windowSize ?? 10_000,
    startBlock: overrides.startBlock,
  };
  return { deps, persisted, cursors, windows };
}

describe('scanFeedbackUris', () => {
  test('paginates from startBlock to head in windowSize windows and advances the cursor', async () => {
    const { deps, windows, cursors } = makeDeps({ getHead: async () => BigInt(25_000), startBlock: BigInt(1), windowSize: 10_000 });
    const res = await scanFeedbackUris(deps);
    expect(windows).toEqual([[BigInt(1), BigInt(10_000)], [BigInt(10_001), BigInt(20_000)], [BigInt(20_001), BigInt(25_000)]]);
    expect(cursors.get(feedbackUriCursorKey('0xREG'))?.last_slot).toBe(25_000);
    expect(res.scanned).toBe(0);
  });

  test('persists only URI-bearing comment rows and counts updates', async () => {
    const { uri, hash } = akDataUri(100, 'great');
    const row: ScannedComment = { agentId: 7, client: '0xabc', feedbackIndex: 0, feedbackUri: uri, feedbackHash: hash, comment: 'great', commentVerified: true, blockNumber: 2_500 };
    const { deps, persisted } = makeDeps({ getHead: async () => BigInt(5_000), startBlock: BigInt(1), logsByWindow: [[row]] });
    const res = await scanFeedbackUris(deps);
    expect(persisted).toEqual([row]);
    expect(res.updated).toBe(1);
    expect(res.scanned).toBe(1);
  });

  test('rewinds the cursor to retry a record whose registry row is missing (UPDATE matched 0)', async () => {
    const { uri, hash } = akDataUri(100, 'pending row');
    const row: ScannedComment = { agentId: 7, client: '0xabc', feedbackIndex: 0, feedbackUri: uri, feedbackHash: hash, comment: 'pending row', commentVerified: true, blockNumber: 4_200 };
    const cursors = new Map<string, { last_signature: string; last_slot: number | null }>();
    const { deps } = makeDeps({
      getHead: async () => BigInt(5_000),
      startBlock: BigInt(1),
      logsByWindow: [[row]],
      // Simulate the registry row not existing yet → 0 matched, record unmatched.
      persistComments: async (rows: ScannedComment[]) => ({ updated: 0, unmatched: rows }),
      getCursor: async (k: string) => cursors.get(k) ?? null,
      upsertCursor: async (k: string, sig: string, slot?: number) => { cursors.set(k, { last_signature: sig, last_slot: slot ?? null }); },
    });
    await scanFeedbackUris(deps);
    // Cursor must NOT advance past the unmatched block (4_200) — it rewinds to
    // 4_199 so the next run re-scans block 4_200 once the registry row lands.
    expect(cursors.get(feedbackUriCursorKey('0xREG'))?.last_slot).toBe(4_199);
  });

  test('resumes from cursor.last_slot + 1', async () => {
    const cursors = new Map<string, { last_signature: string; last_slot: number | null }>([[feedbackUriCursorKey('0xREG'), { last_signature: '9000', last_slot: 9000 }]]);
    const { deps, windows } = makeDeps({
      getHead: async () => BigInt(12_000),
      getCursor: async (k: string) => cursors.get(k) ?? null,
      upsertCursor: async (k: string, s: string, sl?: number) => { cursors.set(k, { last_signature: s, last_slot: sl ?? null }); },
      windowSize: 10_000,
    });
    await scanFeedbackUris(deps);
    expect(windows[0][0]).toBe(BigInt(9001));
  });

  test('no-op when cursor already at/after head (no getLogs call)', async () => {
    const cursors = new Map<string, { last_signature: string; last_slot: number | null }>([[feedbackUriCursorKey('0xREG'), { last_signature: '30000', last_slot: 30_000 }]]);
    let called = 0;
    const { deps } = makeDeps({
      getHead: async () => BigInt(25_000),
      getCursor: async (k: string) => cursors.get(k) ?? null,
      getLogs: async (_f: bigint, _t: bigint) => { called++; return []; },
    });
    const res = await scanFeedbackUris(deps);
    expect(called).toBe(0);
    expect(res.scanned).toBe(0);
  });
});
