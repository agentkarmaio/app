/**
 * AgentKarma feedback-comment payload — the canonical JSON document AK inlines
 * into an ERC-8004 `feedbackURI` as a `data:application/json` URI, and reads
 * back from `NewFeedback` event logs.
 *
 * Why inline data URIs (not hosted JSON / IPFS): the comment then lives fully
 * on-chain — portable, no AK-hosting dependency, and the integrity hash always
 * matches the content. The chain stores `feedbackURI` only in the event (per
 * ERC-8004 spec: endpoint/feedbackURI/feedbackHash are emitted, not stored), so
 * the read side decodes these bytes directly — no network fetch for the common
 * (AK-written) case.
 *
 * Hashing is chain-specific (EVM keccak256 vs Stellar sha256) and stays in the
 * chain adapters: this module exposes the exact bytes, the adapter hashes them.
 * The reader MUST hash the bytes decoded from the URI verbatim — never a
 * re-serialization — so a third party's key ordering still verifies.
 *
 * `parseFeedbackComment` parses UNTRUSTED on-chain JSON: it accepts ONLY the AK
 * schema discriminator and enforces a hard size ceiling, so arbitrary feedback
 * URIs can never be rendered as AgentKarma comments.
 */

export const FEEDBACK_COMMENT_SCHEMA = 'agentkarma/feedback-comment/v1';

/** Write-side cap. Keeps inline calldata small (bounds gas / ledger entry size). */
export const MAX_COMMENT_LEN = 280;

/** Read-side hard ceiling for an untrusted on-chain comment (slack over the
 *  write cap for non-AK writers, but bounded so storage/render can't blow up). */
const READ_MAX_COMMENT_LEN = 2_000;

const DATA_JSON_PREFIX = 'data:application/json';

export interface FeedbackComment {
  schema: string;
  /** 0-100, mirrors the on-chain feedback value. */
  value: number;
  /** Original 1-5 star input, when the comment came from the star UI. */
  stars?: number;
  comment: string;
}

export interface BuildFeedbackCommentInput {
  value: number;
  stars?: number;
  comment: string;
}

/**
 * Build the canonical UTF-8 bytes for a feedback comment. Validates the inputs
 * and raises on anything invalid (AK core rule — no silent coercion). The byte
 * output is what gets base64'd into the data URI AND what the chain adapter
 * hashes, so the two are always derived from the same source.
 */
export function buildFeedbackCommentBytes(input: BuildFeedbackCommentInput): Uint8Array {
  const comment = input.comment.trim();
  if (comment.length === 0) throw new Error('feedback comment is empty');
  if (comment.length > MAX_COMMENT_LEN) {
    throw new Error(`feedback comment exceeds ${MAX_COMMENT_LEN} chars (${comment.length})`);
  }
  if (!Number.isInteger(input.value) || input.value < 0 || input.value > 100) {
    throw new Error(`feedback value must be an integer 0-100, got ${input.value}`);
  }
  if (input.stars !== undefined && (!Number.isInteger(input.stars) || input.stars < 1 || input.stars > 5)) {
    throw new Error(`feedback stars must be an integer 1-5, got ${input.stars}`);
  }

  // Fixed key order → deterministic bytes. `stars` is omitted entirely when absent.
  const payload: FeedbackComment = input.stars === undefined
    ? { schema: FEEDBACK_COMMENT_SCHEMA, value: input.value, comment }
    : { schema: FEEDBACK_COMMENT_SCHEMA, value: input.value, stars: input.stars, comment };

  return new TextEncoder().encode(JSON.stringify(payload));
}

/** `data:application/json;base64,<bytes>` — the inline, fully on-chain URI. */
export function encodeFeedbackCommentDataUri(bytes: Uint8Array): string {
  return `${DATA_JSON_PREFIX};base64,${bytesToBase64(bytes)}`;
}

/**
 * Decode a `data:application/json[;base64],…` URI back to its raw bytes. Returns
 * null for any other scheme/media-type or a malformed URI (the reader then
 * treats the record as "no inline comment"). Mirrors the registration data-URI
 * decoding already used for tokenURIs.
 */
export function decodeFeedbackCommentDataUri(uri: string): Uint8Array | null {
  if (!uri.startsWith(DATA_JSON_PREFIX)) return null;
  const commaIdx = uri.indexOf(',');
  if (commaIdx < 0) return null;

  const header = uri.slice(5, commaIdx); // strip 'data:'
  const params = header.split(';');
  if (params[0] !== 'application/json') return null;

  const body = uri.slice(commaIdx + 1);
  try {
    if (params.includes('base64')) return base64ToBytes(body);
    return new TextEncoder().encode(decodeURIComponent(body));
  } catch {
    return null;
  }
}

/**
 * Parse + validate UNTRUSTED feedback-comment bytes. Returns the normalized
 * comment only when it carries the AK schema discriminator, a string comment
 * within the read ceiling, and a numeric value; otherwise null. Never throws —
 * malformed on-chain data is "no comment", not an error.
 */
export function parseFeedbackComment(bytes: Uint8Array): FeedbackComment | null {
  let obj: unknown;
  try {
    obj = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;

  const rec = obj as Record<string, unknown>;
  if (rec.schema !== FEEDBACK_COMMENT_SCHEMA) return null;
  if (typeof rec.comment !== 'string' || rec.comment.length === 0) return null;
  if (rec.comment.length > READ_MAX_COMMENT_LEN) return null;
  if (typeof rec.value !== 'number' || !Number.isFinite(rec.value)) return null;

  const out: FeedbackComment = {
    schema: FEEDBACK_COMMENT_SCHEMA,
    value: rec.value,
    comment: rec.comment,
  };
  if (typeof rec.stars === 'number' && Number.isFinite(rec.stars)) out.stars = rec.stars;
  return out;
}

// ─── base64 over Uint8Array (runs in both browser and Node, no Buffer) ────────
// Comments are ≤280 chars → payloads are <1KB, so the per-byte loop and
// String.fromCharCode are safe (no call-stack/spread limits). btoa/atob exist on
// globalThis in modern browsers and Node ≥16.

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
