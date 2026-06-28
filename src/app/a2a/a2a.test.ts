/**
 * A2A agent endpoint (/a2a) — JSON-RPC message/send.
 *
 * Pure helpers (extractTarget, summarize) are table-tested with no I/O.
 * Resolution-dependent paths inject a stub via handleMessageSend(deps) so the
 * suite is deterministic and never touches the DB. The non-leak test mirrors
 * mcp-tools.test.ts: a thrown DB error must never reach the caller.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { POST, OPTIONS, extractTarget, summarize, handleMessageSend, type MessageSendDeps } from './route';
import { GET as agentCardGET } from '../well-known/agent-card.json/route';
import { __resetRateLimitForTests } from '@/lib/rate-limit';

const EVM = '0xDC855e86a734AFcC0d719867a597BB0DD74A5a92';
const SOL = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const STELLAR = 'G' + 'A'.repeat(55);

beforeEach(() => __resetRateLimitForTests());

function post(body: unknown, contentType = 'application/json') {
  return new Request('http://localhost/a2a', {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-forwarded-for': '203.0.113.7' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// EVM-shaped karma fixture (declared-tier; no txCount, consumer score null).
const EVM_KARMA = {
  chain: 'celo',
  address: EVM,
  agentId: 9604,
  provider: { score: 95, trustTier: 'Established', confidenceBadge: 'declared', hasSignal: true },
  consumer: { score: null, trustTier: 'Unrated', confidenceBadge: 'declared', hasSignal: false },
  profileUrl: `https://agentkarma.io/agent/${EVM}`,
};
// Solana-shaped karma fixture (has txCount + numeric consumer).
const SOL_KARMA = {
  chain: 'solana',
  address: SOL,
  provider: { score: 80, trustTier: 'Trusted', confidenceBadge: 'receipt-backed' },
  consumer: { score: 70, trustTier: 'Reliable' },
  txCount: 42,
  profileUrl: `https://agentkarma.io/agent/${SOL}`,
};

// A cached erc8004_agents mirror row (snake_case, as getErc8004Agent returns).
const REGISTRY_ROW = {
  chain: 'celo',
  agent_id: 9604,
  owner: EVM,
  agent_wallet: EVM,
  registration: { name: 'Mento Maker', services: [{ name: 'toolkit', endpoint: 'https://usecelina.xyz' }] },
  metadata_score: 95,
  feedback_count: 0,
  feedback_avg: null,
};

function stub(over: Partial<MessageSendDeps> = {}): MessageSendDeps {
  return {
    resolveForChain: (async () => ({ kind: 'evm', snap: {} })) as unknown as MessageSendDeps['resolveForChain'],
    fullKarmaJson: (() => EVM_KARMA) as unknown as MessageSendDeps['fullKarmaJson'],
    getErc8004Agent: (async () => null) as MessageSendDeps['getErc8004Agent'],
    ...over,
  };
}

describe('extractTarget', () => {
  test('extracts EVM 0x from free text', () => {
    expect(extractTarget({ parts: [{ kind: 'text', text: `karma of ${EVM} please` }] })).toEqual({ wallet: EVM, agentId: null, chain: undefined });
  });
  test('extracts Solana base58 + chain word', () => {
    expect(extractTarget({ parts: [{ kind: 'text', text: `score for ${SOL} on solana` }] })).toEqual({ wallet: SOL, agentId: null, chain: 'solana' });
  });
  test('extracts Stellar G-address', () => {
    expect(extractTarget({ parts: [{ kind: 'text', text: `lookup ${STELLAR}` }] }).wallet).toBe(STELLAR);
  });
  test('normalizes chain aliases sol→solana, xlm→stellar', () => {
    expect(extractTarget({ parts: [{ kind: 'text', text: `${EVM} sol` }] }).chain).toBe('solana');
    expect(extractTarget({ parts: [{ kind: 'text', text: `${EVM} xlm` }] }).chain).toBe('stellar');
    expect(extractTarget({ parts: [{ kind: 'text', text: `${EVM} celo` }] }).chain).toBe('celo');
    expect(extractTarget({ parts: [{ kind: 'text', text: `${EVM} arc` }] }).chain).toBe('arc');
  });
  test('structured DataPart wins over conflicting text', () => {
    const msg = { parts: [{ kind: 'text', text: `${SOL} on solana` }, { kind: 'data', data: { wallet: EVM, chain: 'celo' } }] };
    expect(extractTarget(msg)).toEqual({ wallet: EVM, agentId: null, chain: 'celo' });
  });
  test('extracts agentId from text + DataPart, wallet wins over id', () => {
    expect(extractTarget({ parts: [{ kind: 'text', text: 'reputation of agentId 9604 on celo' }] })).toEqual({ wallet: null, agentId: 9604, chain: 'celo' });
    expect(extractTarget({ parts: [{ kind: 'data', data: { agentId: 9605, chain: 'arc' } }] })).toEqual({ wallet: null, agentId: 9605, chain: 'arc' });
    expect(extractTarget({ parts: [{ kind: 'data', data: { wallet: EVM, agentId: 9606 } }] })).toEqual({ wallet: EVM, agentId: null, chain: undefined });
    expect(extractTarget({ parts: [{ kind: 'text', text: 'tell me about agentkarma 9999' }] }).agentId).toBeNull();
  });
  test('accepts address/agent keys in DataPart', () => {
    expect(extractTarget({ parts: [{ kind: 'data', data: { address: EVM } }] }).wallet).toBe(EVM);
    expect(extractTarget({ parts: [{ kind: 'data', data: { agent: EVM } }] }).wallet).toBe(EVM);
  });
  test('no address → wallet null', () => {
    expect(extractTarget({ parts: [{ kind: 'text', text: 'hello there' }] }).wallet).toBeNull();
    expect(extractTarget({ parts: [] }).wallet).toBeNull();
  });
});

describe('summarize', () => {
  test('EVM shape: declared-tier consumer, both faces present', () => {
    const s = summarize(EVM_KARMA);
    expect(s).toContain('Provider 95/100');
    expect(s).toContain('Consumer Unrated');
    expect(s).toContain(EVM);
    expect(s).toContain('agentkarma.io/agent/');
  });
  test('Solana shape: numeric consumer + tx count', () => {
    const s = summarize(SOL_KARMA);
    expect(s).toContain('Provider 80/100');
    expect(s).toContain('Consumer 70/100');
    expect(s).toContain('42 indexed tx');
  });
});

describe('message/send (handleMessageSend, injected deps)', () => {
  test('happy path → Message with text + data, two-faced', async () => {
    const res = await handleMessageSend(1, { message: { parts: [{ kind: 'text', text: `karma of ${EVM} on celo` }] } }, {}, stub());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result.kind).toBe('message');
    expect(body.result.role).toBe('agent');
    expect(typeof body.result.messageId).toBe('string');
    expect(body.result.parts).toHaveLength(2);
    expect(body.result.parts[0].kind).toBe('text');
    expect(body.result.parts[0].text).toContain('Provider');
    expect(body.result.parts[0].text).toContain('Consumer');
    expect(body.result.parts[1].kind).toBe('data');
    expect(body.result.parts[1].data).toEqual(EVM_KARMA);
  });

  test('structured DataPart + Solana fixture', async () => {
    const deps = stub({ resolveForChain: (async () => ({ kind: 'solana', snap: {} })) as unknown as MessageSendDeps['resolveForChain'], fullKarmaJson: (() => SOL_KARMA) as unknown as MessageSendDeps['fullKarmaJson'] });
    const res = await handleMessageSend(2, { message: { parts: [{ kind: 'data', data: { wallet: SOL } }] } }, {}, deps);
    const body = await res.json();
    expect(body.result.parts[1].data.txCount).toBe(42);
  });

  test('not-found → Message (not error) with found:false', async () => {
    const deps = stub({ resolveForChain: (async () => null) as MessageSendDeps['resolveForChain'] });
    const res = await handleMessageSend(3, { message: { parts: [{ kind: 'text', text: `karma of ${EVM}` }] } }, {}, deps);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.result.kind).toBe('message');
    expect(body.result.parts[1].data.found).toBe(false);
  });

  test('no wallet in content → friendly prompt Message, not -32602', async () => {
    const res = await handleMessageSend(4, { message: { parts: [{ kind: 'text', text: 'hi' }] } }, {}, stub());
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.result.parts[1].data.reason).toBe('no_target');
  });

  test('agentId lookup → registry-agent Message (probes celo)', async () => {
    const deps = stub({
      getErc8004Agent: (async (c: string) => (c === 'celo' ? REGISTRY_ROW : null)) as unknown as MessageSendDeps['getErc8004Agent'],
    });
    const res = await handleMessageSend(20, { message: { parts: [{ kind: 'text', text: 'reputation of agentId 9604 on celo' }] } }, {}, deps);
    const body = await res.json();
    expect(body.result.kind).toBe('message');
    expect(body.result.parts[0].text).toContain('Mento Maker');
    expect(body.result.parts[0].text).toContain('Provider 95/100');
    const d = body.result.parts[1].data;
    expect(d.kind).toBe('registry-agent');
    expect(d.agentId).toBe(9604);
    expect(d.chain).toBe('celo');
    expect(d.provider.score).toBe(95);
    expect(d.consumer.score).toBeNull();
  });

  test('agentId not found on either chain → found:false (not an error)', async () => {
    const deps = stub({ getErc8004Agent: (async () => null) as MessageSendDeps['getErc8004Agent'] });
    const res = await handleMessageSend(21, { message: { parts: [{ kind: 'data', data: { agentId: 9604 } }] } }, {}, deps);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.result.parts[1].data.found).toBe(false);
  });

  test('too-short DataPart wallet → invalid_address prompt', async () => {
    const res = await handleMessageSend(5, { message: { parts: [{ kind: 'data', data: { wallet: '0xabc' } }] } }, {}, stub());
    const body = await res.json();
    expect(body.result.parts[1].data.reason).toBe('invalid_address');
  });

  test('empty params/message → -32602', async () => {
    expect((await (await handleMessageSend(6, {}, {}, stub())).json()).error.code).toBe(-32602);
    expect((await (await handleMessageSend(7, { message: { parts: [] } }, {}, stub())).json()).error.code).toBe(-32602);
  });

  test('ERROR NON-LEAK: thrown DB error never reaches the caller', async () => {
    const secret = 'connection terminated: postgres://user:pa55w0rd@10.0.0.5:5432/db\n  at PgClient.connect';
    const deps = stub({
      resolveForChain: (async () => {
        throw new Error(secret);
      }) as MessageSendDeps['resolveForChain'],
    });
    const res = await handleMessageSend(8, { message: { parts: [{ kind: 'text', text: `karma of ${EVM}` }] } }, {}, deps);
    const body = await res.json();
    expect(body.error.code).toBe(-32603);
    const serialized = JSON.stringify(body);
    for (const leak of ['pa55w0rd', '10.0.0.5', 'postgres://', 'connection terminated', 'PgClient']) {
      expect(serialized).not.toContain(leak);
    }
    expect(serialized).not.toContain('\n');
  });
});

describe('POST envelope', () => {
  test('malformed JSON → -32700, id null', async () => {
    const body = await (await POST(post('{nope'))).json();
    expect(body.error.code).toBe(-32700);
    expect(body.id).toBeNull();
  });
  test('wrong jsonrpc version → -32600', async () => {
    expect((await (await POST(post({ jsonrpc: '1.0', id: 1, method: 'message/send' }))).json()).error.code).toBe(-32600);
  });
  test('missing method → -32600', async () => {
    expect((await (await POST(post({ jsonrpc: '2.0', id: 1 }))).json()).error.code).toBe(-32600);
  });
  test('unknown method → -32601', async () => {
    for (const m of ['tasks/get', 'message/stream', 'frobnicate']) {
      const body = await (await POST(post({ jsonrpc: '2.0', id: 1, method: m }))).json();
      expect(body.error.code).toBe(-32601);
      expect(body.result).toBeUndefined();
    }
  });
  test('non-JSON content-type → 415 / -32600', async () => {
    const res = await POST(post('{}', 'text/plain'));
    expect(res.status).toBe(415);
    expect((await res.json()).error.code).toBe(-32600);
  });
  test('oversized body → -32600, resolution not reached', async () => {
    const huge = { jsonrpc: '2.0', id: 1, method: 'message/send', pad: 'x'.repeat(70 * 1024) };
    expect((await (await POST(post(huge))).json()).error.code).toBe(-32600);
  });
  test('rate-limit 429 is a JSON-RPC envelope, not the limiter raw body', async () => {
    let limited: { jsonrpc?: string; error?: { code?: number; message?: string } } | undefined;
    for (let i = 0; i < 60 && !limited; i++) {
      const res = await POST(post({ jsonrpc: '2.0', id: 1, method: 'tasks/get' }));
      if (res.status === 429) limited = await res.json();
    }
    expect(limited).toBeDefined();
    expect(limited!.jsonrpc).toBe('2.0');
    expect(limited!.error!.code).toBe(-32000);
    expect(limited!.error!.message).toBe('Rate limit exceeded');
  });
  test('no-address text via POST → friendly Message (real deps, no DB)', async () => {
    const body = await (await POST(post({ jsonrpc: '2.0', id: 9, method: 'message/send', params: { message: { parts: [{ kind: 'text', text: 'hello' }] } } }))).json();
    expect(body.result.parts[1].data.reason).toBe('no_target');
  });
});

describe('OPTIONS + AgentCard contract', () => {
  test('OPTIONS → 204 with CORS', async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });
  test('AgentCard advertises /a2a as JSONRPC + keeps MCP', async () => {
    const card = await (agentCardGET() as Response).json();
    expect(card.url.endsWith('/a2a')).toBe(true);
    expect(card.preferredTransport).toBe('JSONRPC');
    const transports = card.additionalInterfaces.map((i: { transport: string }) => i.transport);
    expect(transports).toContain('JSONRPC');
    expect(transports).toContain('MCP');
  });
});
