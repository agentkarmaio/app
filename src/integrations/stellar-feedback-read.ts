/** Contract-authoritative Stellar feedback, with optional explicitly unverified explorer comments. */
import { Address, nativeToScVal, type rpc } from '@stellar/stellar-sdk';
import { AK_REVIEW_TAG1 } from '@/config/ak-validator';
import { decodeStellarFeedbackRecord, type StellarFeedbackRecord } from '@/lib/stellar-feedback';
import { decodeFeedbackCommentDataUri, parseFeedbackComment } from '@/lib/feedback-comment';
import { STELLAR_REPUTATION_REGISTRY } from './stellar-config';
import { simulateView } from './erc8004-stellar';

export interface StellarFeedbackReadOptions {
  view?: typeof simulateView;
  fetch?: typeof fetch;
  maxClients?: number;
  maxRecords?: number;
  includeComments?: boolean;
}
export interface StellarFeedbackReadResult {
  records: StellarFeedbackRecord[];
  count: number | null;
  average: number | null;
  complete: boolean;
  /** Whether the optional explorer enrichment completed, not proof of comment integrity. */
  commentsComplete: boolean;
}
const CLIENT_PAGE = 20;
const MAX_BODY_BYTES = 512_000;
const READ_BUDGET_MS = 15_000;
function bounded(value: number | undefined, fallback: number, max: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.min(max, Math.max(1, Math.floor(value))) : fallback;
}

/** Bound both advertised and actual bytes; never follow an explorer redirect or user-supplied URI. */
async function readExplorerPage(fetcher: typeof fetch, agentId: number, page: number): Promise<Record<string, unknown>> {
  const response = await fetcher(`https://stellar8004.com/api/v1/agents/${agentId}/feedback?page=${page}&limit=100`, {
    redirect: 'error', signal: AbortSignal.timeout(5_000), cache: 'no-store',
  });
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > MAX_BODY_BYTES || !response.body) {
    throw new Error('Stellar feedback enrichment unavailable');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) throw new Error('Stellar feedback enrichment too large');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid Stellar feedback enrichment');
  return parsed as Record<string, unknown>;
}

async function enrichComments(records: StellarFeedbackRecord[], agentId: number, fetcher: typeof fetch, deadline: number): Promise<boolean> {
  const byIdentity = new Map(records.map((record) => [`${record.client}:${record.feedbackIndex}`, record]));
  try {
    for (let page = 1; page <= 5; page++) {
      if (Date.now() >= deadline) return false;
      const response = await readExplorerPage(fetcher, agentId, page);
      const meta = response.meta as Record<string, unknown> | undefined;
      const pagination = meta?.pagination as Record<string, unknown> | undefined;
      if (response.success !== true || !Array.isArray(response.data) || response.data.length > 100
        || meta?.chain !== 'stellar' || meta?.network !== 'mainnet'
        || pagination?.page !== page || typeof pagination.hasMore !== 'boolean') return false;
      for (const item of response.data) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        if (typeof row.clientAddress !== 'string' || !Number.isSafeInteger(row.feedbackIndex)
          || Number(row.feedbackIndex) < 1) continue;
        const record = byIdentity.get(`${row.clientAddress}:${row.feedbackIndex}`);
        // Only enrich an exact contract identity/value/scheme. The API never overrides authority.
        if (!record || typeof row.value !== 'number' || !Number.isSafeInteger(row.value)
          || String(row.value) !== record.rawValue || row.valueDecimals !== record.valueDecimals
          || (row.tag1 ?? '') !== record.tag1 || (row.tag2 ?? '') !== record.tag2
          || row.isRevoked !== record.revoked || typeof row.feedbackUri !== 'string'
          || row.feedbackUri.length > 16_384) continue;
        const bytes = decodeFeedbackCommentDataUri(row.feedbackUri);
        const comment = bytes && parseFeedbackComment(bytes);
        if (!comment || comment.value !== record.value) continue;
        record.comment = comment.comment;
        record.commentVerified = false; // Explorer API does not expose the event's feedback_hash.
      }
      if (!pagination.hasMore) return true;
      if (response.data.length === 0) return false;
    }
  } catch { /* Enrichment is optional; contract records remain visible. */ }
  return false;
}

export async function readStellarFeedback(
  server: rpc.Server,
  agentId: number,
  options: StellarFeedbackReadOptions = {},
): Promise<StellarFeedbackReadResult> {
  if (!Number.isInteger(agentId) || agentId < 0 || agentId > 0xffffffff) throw new Error('Invalid Stellar agent ID');
  const view = options.view ?? simulateView;
  const maxClients = bounded(options.maxClients, 100, 100);
  const maxRecords = bounded(options.maxRecords, 200, 200);
  const deadline = Date.now() + READ_BUDGET_MS;
  async function call(method: string, args: Parameters<typeof simulateView>[1]['args']): Promise<unknown> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Feedback read budget exceeded');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        view(server, { contractId: STELLAR_REPUTATION_REGISTRY, method, args }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Feedback read timed out')), Math.min(5_000, remaining)); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  const idArg = nativeToScVal(agentId, { type: 'u32' });
  const clients: string[] = [];
  const records: StellarFeedbackRecord[] = [];
  let complete = true;
  try {
    let exhausted = false;
    for (let offset = 0; offset < maxClients; offset += CLIENT_PAGE) {
      const limit = Math.min(CLIENT_PAGE, maxClients - offset);
      const page = await call('get_clients_paginated', [idArg, nativeToScVal(offset, { type: 'u32' }), nativeToScVal(limit, { type: 'u32' })]);
      if (!Array.isArray(page) || page.length > limit || page.some((client) => typeof client !== 'string')) throw new Error('Invalid feedback clients');
      for (const client of page as string[]) {
        if (clients.includes(client)) throw new Error('Repeated feedback client');
        clients.push(client);
      }
      if (page.length < limit) { exhausted = true; break; }
    }
    if (!exhausted) {
      // A full final page does not prove that all raters were visited.
      const next = await call('get_clients_paginated', [idArg, nativeToScVal(maxClients, { type: 'u32' }), nativeToScVal(1, { type: 'u32' })]);
      complete = Array.isArray(next) && next.length === 0;
    }
  } catch { complete = false; }
  try {
    let attempted = 0;
    for (const client of clients) {
      try {
        const address = new Address(client).toScVal();
        const last = await call('get_last_index', [idArg, address]);
        if (typeof last !== 'bigint' || last < 0n || last > 0xffffffffffffffffn) throw new Error('Invalid feedback index');
        for (let index = 1n; index <= last; index++) {
          if (attempted >= maxRecords || Date.now() >= deadline) { complete = false; break; }
          attempted++;
          try {
            const raw = await call('read_feedback', [idArg, address, nativeToScVal(index, { type: 'u64' })]);
            records.push(decodeStellarFeedbackRecord(client, index, raw));
          } catch { complete = false; }
        }
      } catch { complete = false; }
      if (Date.now() >= deadline || (attempted >= maxRecords && client !== clients[clients.length - 1])) {
        complete = false;
        break;
      }
    }
  } catch { complete = false; }
  const live = records.filter((record) => !record.revoked);
  // Registry tags can express unrelated units (latency, uptime, etc.). Only AK's rating scheme is comparable.
  const reviews = live.filter((record) => record.tag1 === AK_REVIEW_TAG1 && record.value >= 0 && record.value <= 100);
  const commentsComplete = records.length === 0
    ? complete
    : options.includeComments === false ? false
      : await enrichComments(records, agentId, options.fetch ?? fetch, deadline);
  return {
    records,
    count: complete ? live.length : null,
    average: complete && reviews.length > 0 ? reviews.reduce((sum, record) => sum + record.value, 0) / reviews.length : null,
    complete, commentsComplete,
  };
}
