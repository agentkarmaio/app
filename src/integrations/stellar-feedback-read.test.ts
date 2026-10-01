import { describe, expect, test } from 'bun:test';
import { Keypair, scValToNative, type rpc } from '@stellar/stellar-sdk';
import { readStellarFeedback } from './stellar-feedback-read';
import type { simulateView } from './erc8004-stellar';
import { buildFeedbackCommentBytes, encodeFeedbackCommentDataUri } from '@/lib/feedback-comment';

const clients = [81, 82].map((byte) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, byte)).publicKey());
const server = {} as rpc.Server;
const record = (value = 80n, rest = {}) => ({ value, value_decimals: 0, is_revoked: false, tag1: 'agentkarma_review', tag2: 'v0.1', ...rest });

function readerFixture(entries: unknown[][]) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const view: typeof simulateView = async (_server, request) => {
    const args = request.args.map(scValToNative);
    calls.push({ method: request.method, args });
    if (request.method === 'get_clients_paginated') {
      const offset = Number(args[1]); const limit = Number(args[2]);
      return clients.slice(0, entries.length).slice(offset, offset + limit);
    }
    const client = String(args[1]); const index = clients.indexOf(client);
    if (request.method === 'get_last_index') return BigInt(entries[index]?.length ?? 0);
    if (request.method === 'read_feedback') {
      const entry = entries[index]?.[Number(args[2]) - 1];
      if (entry instanceof Error) throw entry;
      return entry;
    }
    throw new Error(`Unexpected view ${request.method}`);
  };
  return { view, calls };
}

describe('Stellar feedback read boundaries', () => {
  test('a successfully read empty registry is known empty', async () => {
    const fixture = readerFixture([]);
    const result = await readStellarFeedback(server, 7, { view: fixture.view, includeComments: false });
    expect(result.records).toEqual([]); expect(result.count).toBe(0);
    expect(result.average).toBeNull(); expect(result.complete).toBe(true);
  });

  test('RPC unavailability is not a known-empty registry', async () => {
    const result = await readStellarFeedback(server, 7, { view: async () => { throw new Error('RPC unavailable'); }, includeComments: false });
    expect(result.count).toBeNull(); expect(result.average).toBeNull(); expect(result.complete).toBe(false);
  });

  test('reads every client and feedback index, preserving raw precision and revocations', async () => {
    const fixture = readerFixture([[record(80n), record(20n, { is_revoked: true })], [record(60n)]]);
    const result = await readStellarFeedback(server, 7, { view: fixture.view, includeComments: false });
    expect(result.complete).toBe(true);
    expect(result.records).toHaveLength(3);
    expect(result.records.find((r) => r.revoked)).toMatchObject({ client: clients[0], feedbackIndex: '2', rawValue: '20' });
    expect(result.count).toBe(2); expect(result.average).toBe(70);
    expect(fixture.calls.filter((c) => c.method === 'read_feedback')).toHaveLength(3);
  });

  test('an archived or unavailable middle record does not fabricate complete history', async () => {
    const fixture = readerFixture([[record(), new Error('archived'), record(60n)]]);
    const result = await readStellarFeedback(server, 7, { view: fixture.view, includeComments: false });
    expect(result.complete).toBe(false); expect(result.count).toBeNull(); expect(result.average).toBeNull();
    expect(result.records).toHaveLength(2);
  });

  test('an unreadable client index does not hide other clients', async () => {
    const fixture = readerFixture([[record()], [record(60n)]]);
    const view: typeof simulateView = async (s, request) => {
      if (request.method === 'get_last_index' && scValToNative(request.args[1]) === clients[0]) throw new Error('index archived');
      return fixture.view(s, request);
    };
    const result = await readStellarFeedback(server, 7, { view, includeComments: false });
    expect(result.complete).toBe(false); expect(result.count).toBeNull();
    expect(result.records).toHaveLength(1); expect(result.records[0].client).toBe(clients[1]);
  });

  test('a full client page continues discovery and reads the second page', async () => {
    const many = Array.from({ length: 21 }, (_, n) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, n + 91)).publicKey());
    const offsets: number[] = [];
    const view: typeof simulateView = async (_server, request) => {
      const args = request.args.map(scValToNative);
      if (request.method === 'get_clients_paginated') { offsets.push(Number(args[1])); return many.slice(Number(args[1]), Number(args[1]) + Number(args[2])); }
      if (request.method === 'get_last_index') return 1n;
      if (request.method === 'read_feedback') return record();
      throw new Error('unexpected method');
    };
    const result = await readStellarFeedback(server, 7, { view, includeComments: false });
    expect(offsets).toEqual([0, 20]); expect(result.records).toHaveLength(21); expect(result.complete).toBe(true);
  });

  test('failed second-page discovery preserves records from the first client page', async () => {
    const many = Array.from({ length: 20 }, (_, n) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, n + 91)).publicKey());
    const view: typeof simulateView = async (_server, request) => {
      if (request.method === 'get_clients_paginated') {
        if (Number(scValToNative(request.args[1])) > 0) throw new Error('page two unavailable');
        return many;
      }
      if (request.method === 'get_last_index') return 1n;
      if (request.method === 'read_feedback') return record();
      throw new Error('unexpected method');
    };
    const result = await readStellarFeedback(server, 7, { view, includeComments: false });
    expect(result.complete).toBe(false); expect(result.count).toBeNull(); expect(result.records).toHaveLength(20);
  });

  test('the record budget bounds reads across clients', async () => {
    const fixture = readerFixture([[record()], [record()]]);
    const result = await readStellarFeedback(server, 7, { view: fixture.view, includeComments: false, maxRecords: 1 });
    expect(result.complete).toBe(false); expect(result.records).toHaveLength(1);
    expect(fixture.calls.filter((call) => call.method === 'read_feedback')).toHaveLength(1);
  });

  test('a record cap returns observations but no complete aggregate', async () => {
    const fixture = readerFixture([[record(), record(60n), record(100n)]]);
    const result = await readStellarFeedback(server, 7, { view: fixture.view, includeComments: false, maxRecords: 2 });
    expect(result.records).toHaveLength(2); expect(result.complete).toBe(false);
    expect(result.count).toBeNull(); expect(result.average).toBeNull();
  });

  test('a client cap cannot be reported as complete', async () => {
    const fixture = readerFixture([[record()], [record(60n)]]);
    const result = await readStellarFeedback(server, 7, { view: fixture.view, includeComments: false, maxClients: 1 });
    expect(result.complete).toBe(false); expect(result.count).toBeNull(); expect(result.average).toBeNull();
  });

  test('unrelated tagged values are preserved without polluting the review average', async () => {
    const fixture = readerFixture([[record(80n), record(900n, { tag1: 'latency', tag2: 'milliseconds' }), record(600n, { value_decimals: 1 })]]);
    const result = await readStellarFeedback(server, 7, { view: fixture.view, includeComments: false });
    expect(result.records).toHaveLength(3);
    expect(result.records.find((r) => r.tag1 === 'latency')).toMatchObject({ rawValue: '900', value: 900 });
    expect(result.records.find((r) => r.valueDecimals === 1)).toMatchObject({ rawValue: '600', value: 60 });
    expect(result.average).toBe(70);
  });

  test('disabled comments never make external requests', async () => {
    const fixture = readerFixture([[record()]]);
    let requested = false;
    const result = await readStellarFeedback(server, 7, { view: fixture.view, includeComments: false, fetch: (async () => { requested = true; throw new Error('unexpected request'); }) as unknown as typeof fetch });
    expect(result.complete).toBe(true); expect(requested).toBe(false);
  });
});

function explorerReply(data: unknown[], page = 1, hasMore = false, network = 'mainnet') {
  return { success: true, data, meta: { chain: 'stellar', network, pagination: { page, hasMore } } };
}
function explorerRow(overrides = {}) {
  return { clientAddress: clients[0], feedbackIndex: 1, value: 80, valueDecimals: 0, tag1: 'agentkarma_review', tag2: 'v0.1', isRevoked: false,
    feedbackUri: encodeFeedbackCommentDataUri(buildFeedbackCommentBytes({ value: 80, stars: 4, comment: 'Explorer comment' })), ...overrides };
}
function jsonFetcher(body: unknown): typeof fetch {
  return (async () => Response.json(body)) as unknown as typeof fetch;
}

describe('Stellar explorer enrichment stays bounded and non-authoritative', () => {
  test('an exact identity/value/scheme match displays a comment explicitly unverified', async () => {
    const fixture = readerFixture([[record()]]);
    const result = await readStellarFeedback(server, 7, { view: fixture.view, fetch: jsonFetcher(explorerReply([explorerRow()])) });
    expect(result.records[0]).toMatchObject({ comment: 'Explorer comment', commentVerified: false, value: 80 });
    expect(result.commentsComplete).toBe(true);
  });

  test.each([
    { clientAddress: clients[1] }, { feedbackIndex: 2 }, { value: 100 }, { valueDecimals: 1 },
    { tag1: 'provider' }, { tag2: 'other' }, { isRevoked: true }, { feedbackIndex: Number.MAX_SAFE_INTEGER + 1 },
    { feedbackUri: 'https://private.example/comment.json' }, { feedbackUri: 'x'.repeat(16_385) },
  ])('untrusted explorer fields cannot override authoritative feedback', async (change) => {
    const fixture = readerFixture([[record()]]);
    const result = await readStellarFeedback(server, 7, { view: fixture.view, fetch: jsonFetcher(explorerReply([explorerRow(change)])) });
    expect(result.records[0]).toMatchObject({ client: clients[0], feedbackIndex: '1', value: 80, revoked: false });
    expect(result.records[0].comment).toBeUndefined();
  });

  test('wrong network enrichment is discarded while contract data stays visible', async () => {
    const fixture = readerFixture([[record()]]);
    const result = await readStellarFeedback(server, 7, { view: fixture.view, fetch: jsonFetcher(explorerReply([explorerRow()], 1, false, 'testnet')) });
    expect(result.commentsComplete).toBe(false); expect(result.complete).toBe(true); expect(result.records[0].comment).toBeUndefined();
  });

  test('follows explorer pagination using fixed origin and redirect rejection', async () => {
    const fixture = readerFixture([[record(), record(60n)]]); const urls: string[] = [];
    const fetcher = (async (url: string, options?: RequestInit) => {
      urls.push(url); expect(options?.redirect).toBe('error');
      expect(new URL(url).origin).toBe('https://stellar8004.com');
      return Response.json(explorerReply([explorerRow()], urls.length, urls.length === 1));
    }) as unknown as typeof fetch;
    const result = await readStellarFeedback(server, 7, { view: fixture.view, fetch: fetcher });
    expect(urls).toHaveLength(2); expect(result.commentsComplete).toBe(true);
  });

  test('endless explorer pages stop at five and disclose incomplete comments', async () => {
    const fixture = readerFixture([[record()]]); let calls = 0;
    const fetcher = (async () => Response.json(explorerReply([explorerRow()], ++calls, true))) as unknown as typeof fetch;
    const result = await readStellarFeedback(server, 7, { view: fixture.view, fetch: fetcher });
    expect(calls).toBe(5); expect(result.commentsComplete).toBe(false); expect(result.complete).toBe(true);
  });

  test.each(['advertised', 'actual', 'http', 'json', 'null', 'empty-more'])('enrichment %s failure does not hide chain feedback', async (failure) => {
    const fixture = readerFixture([[record()]]);
    const fetcher = (async () => {
      if (failure === 'advertised') return new Response('{}', { headers: { 'content-length': '512001' } });
      if (failure === 'actual') return new Response(' '.repeat(512001));
      if (failure === 'http') return new Response('{}', { status: 503 });
      if (failure === 'json') return new Response('{');
      if (failure === 'null') return Response.json(null);
      return Response.json(explorerReply([], 1, true));
    }) as unknown as typeof fetch;
    const result = await readStellarFeedback(server, 7, { view: fixture.view, fetch: fetcher });
    expect(result.complete).toBe(true); expect(result.count).toBe(1); expect(result.commentsComplete).toBe(false);
  });
});
