/// <reference types="bun-types" />
/**
 * feedback-comment payload — the canonical document AgentKarma inlines into an
 * ERC-8004 `feedbackURI` (data: URI) and reads back from `NewFeedback` events.
 * Both write and read sides depend on this round-tripping byte-for-byte, and
 * `parseFeedbackComment` parses UNTRUSTED on-chain JSON — so the adversarial
 * cases (wrong schema, junk bytes, oversize) are as load-bearing as the happy path.
 */
import { describe, expect, test } from 'bun:test';
import {
  FEEDBACK_COMMENT_SCHEMA,
  MAX_COMMENT_LEN,
  buildFeedbackCommentBytes,
  encodeFeedbackCommentDataUri,
  decodeFeedbackCommentDataUri,
  parseFeedbackComment,
} from './feedback-comment';

describe('buildFeedbackCommentBytes', () => {
  test('emits canonical JSON with schema + value + trimmed comment', () => {
    const bytes = buildFeedbackCommentBytes({ value: 100, comment: '  great agent  ' });
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    expect(obj.schema).toBe(FEEDBACK_COMMENT_SCHEMA);
    expect(obj.value).toBe(100);
    expect(obj.comment).toBe('great agent'); // trimmed
    expect('stars' in obj).toBe(false); // omitted when not given
  });

  test('includes stars when provided', () => {
    const bytes = buildFeedbackCommentBytes({ value: 60, stars: 3, comment: 'ok' });
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    expect(obj.stars).toBe(3);
  });

  test('rejects empty / whitespace-only comment', () => {
    expect(() => buildFeedbackCommentBytes({ value: 100, comment: '' })).toThrow();
    expect(() => buildFeedbackCommentBytes({ value: 100, comment: '   ' })).toThrow();
  });

  test('rejects comment longer than MAX_COMMENT_LEN', () => {
    const long = 'x'.repeat(MAX_COMMENT_LEN + 1);
    expect(() => buildFeedbackCommentBytes({ value: 100, comment: long })).toThrow();
    expect(() => buildFeedbackCommentBytes({ value: 100, comment: 'x'.repeat(MAX_COMMENT_LEN) })).not.toThrow();
  });

  test('rejects out-of-range / non-integer value', () => {
    expect(() => buildFeedbackCommentBytes({ value: -1, comment: 'x' })).toThrow();
    expect(() => buildFeedbackCommentBytes({ value: 101, comment: 'x' })).toThrow();
    expect(() => buildFeedbackCommentBytes({ value: 50.5, comment: 'x' })).toThrow();
  });
});

describe('data URI round-trip', () => {
  test('encode → decode → parse preserves comment / value / stars', () => {
    const bytes = buildFeedbackCommentBytes({ value: 80, stars: 4, comment: 'fast, reliable' });
    const uri = encodeFeedbackCommentDataUri(bytes);
    expect(uri.startsWith('data:application/json;base64,')).toBe(true);

    const decoded = decodeFeedbackCommentDataUri(uri);
    expect(decoded).not.toBeNull();
    expect(decoded).toEqual(bytes); // exact bytes — required for hash verification

    const parsed = parseFeedbackComment(decoded!);
    expect(parsed).toEqual({ schema: FEEDBACK_COMMENT_SCHEMA, value: 80, stars: 4, comment: 'fast, reliable' });
  });

  test('handles unicode comments without corruption', () => {
    const bytes = buildFeedbackCommentBytes({ value: 100, comment: 'café ☕ 日本語 🤖' });
    const parsed = parseFeedbackComment(decodeFeedbackCommentDataUri(encodeFeedbackCommentDataUri(bytes))!);
    expect(parsed?.comment).toBe('café ☕ 日本語 🤖');
  });
});

describe('decodeFeedbackCommentDataUri', () => {
  test('decodes a non-base64 (url-encoded) data URI too', () => {
    const uri = `data:application/json,${encodeURIComponent(JSON.stringify({ schema: FEEDBACK_COMMENT_SCHEMA, value: 100, comment: 'hi' }))}`;
    const parsed = parseFeedbackComment(decodeFeedbackCommentDataUri(uri)!);
    expect(parsed?.comment).toBe('hi');
  });

  test('returns null for non-data URIs', () => {
    expect(decodeFeedbackCommentDataUri('https://agentkarma.io/x.json')).toBeNull();
    expect(decodeFeedbackCommentDataUri('ipfs://Qm...')).toBeNull();
    expect(decodeFeedbackCommentDataUri('')).toBeNull();
  });

  test('returns null for wrong media type or malformed', () => {
    expect(decodeFeedbackCommentDataUri('data:text/plain;base64,aGk=')).toBeNull();
    expect(decodeFeedbackCommentDataUri('data:application/json;base64')).toBeNull(); // no comma
  });
});

describe('parseFeedbackComment (untrusted on-chain JSON)', () => {
  test('rejects valid JSON that is not the AK comment schema', () => {
    const other = new TextEncoder().encode(JSON.stringify({ schema: 'someone-else/v1', value: 100, comment: 'x' }));
    expect(parseFeedbackComment(other)).toBeNull();
    const noSchema = new TextEncoder().encode(JSON.stringify({ value: 100, comment: 'x' }));
    expect(parseFeedbackComment(noSchema)).toBeNull();
  });

  test('rejects junk / non-object / missing comment', () => {
    expect(parseFeedbackComment(new TextEncoder().encode('not json'))).toBeNull();
    expect(parseFeedbackComment(new TextEncoder().encode('[]'))).toBeNull();
    expect(parseFeedbackComment(new TextEncoder().encode(JSON.stringify({ schema: FEEDBACK_COMMENT_SCHEMA, value: 1 })))).toBeNull();
    expect(parseFeedbackComment(new TextEncoder().encode(JSON.stringify({ schema: FEEDBACK_COMMENT_SCHEMA, comment: 5 })))).toBeNull();
  });

  test('rejects a pathologically oversize comment (read hard cap)', () => {
    const huge = JSON.stringify({ schema: FEEDBACK_COMMENT_SCHEMA, value: 100, comment: 'x'.repeat(10_000) });
    expect(parseFeedbackComment(new TextEncoder().encode(huge))).toBeNull();
  });
});
