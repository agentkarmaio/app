import { describe, expect, test } from 'bun:test';
import { handleTelegram, type TelegramDeps } from './telegram-agent';

const secret = 'test-only-webhook-secret';
function request(body: unknown, key: string | null = secret) {
  return new Request('https://agentkarma.io/api/v2/telegram', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(key === null ? {} : { 'x-telegram-bot-api-secret-token': key }) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
function update(id = 1, text = '/start', user = 42) {
  return { update_id: id, message: { message_id: id, from: { id: user, is_bot: false }, chat: { id: user, type: 'private' }, text } };
}
function setup(overrides: Partial<TelegramDeps> = {}) {
  const calls: unknown[] = [];
  const deps: TelegramDeps = {
    secret: () => secret, now: () => 10000,
    updates: new Map(), cooldowns: new Map(), inFlight: new Set(),
    limit: async () => ({ success: true }),
    query: async (id, message) => {
      calls.push(message);
      return Response.json({ jsonrpc: '2.0', id, result: { kind: 'message', role: 'agent', parts: [
        { kind: 'text', text: 'Public reputation result' },
        { kind: 'data', data: { chain: 'celo', provider: { score: 80, confidenceBadge: 'declared' }, consumer: { score: null, confidenceBadge: 'declared' }, profileUrl: 'https://agentkarma.io/agent/0xCfc0A11C75519FAf85B7872E27733CFaa4295b96?chain=celo&agentId=9058' } },
      ] } });
    }, ...overrides,
  };
  return { deps, calls };
}

describe('Telegram webhook', () => {
  test('fails closed with absent configuration or wrong/missing authentication', async () => {
    const { deps, calls } = setup();
    expect((await handleTelegram(request(update(), null), deps)).status).toBe(401);
    expect((await handleTelegram(request(update(), 'wrong'), deps)).status).toBe(401);
    expect((await handleTelegram(request(update()), { ...deps, secret: () => undefined })).status).toBe(503);
    expect(calls).toHaveLength(0);
  });
  test('bounds the request body and handles invalid JSON/schema', async () => {
    const { deps } = setup();
    expect((await handleTelegram(request('x'.repeat(17000)), deps)).status).toBe(413);
    expect((await handleTelegram(request('{'), deps)).status).toBe(400);
    expect((await handleTelegram(request({ update_id: -1 }), deps)).status).toBe(400);
    const req = new Request('https://agentkarma.io/api/v2/telegram', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret }, body: '{}' });
    expect((await handleTelegram(req, deps)).status).toBe(415);
  });
  test('only responds to private human chats, not groups/bots/other updates', async () => {
    const { deps, calls } = setup();
    const group = update(); group.message.chat.type = 'group';
    const bot = update(2); bot.message.from.is_bot = true;
    for (const body of [group, bot, { update_id: 3, edited_message: update().message }]) {
      expect(await (await handleTelegram(request(body), deps)).json()).toEqual({ ok: true });
    }
    expect(calls).toHaveLength(0);
  });
  test('welcome/help respond through Telegram webhook JSON without fetching or needing a bot token', async () => {
    for (const text of ['/start', '/start@agentkarmabot', '/help', '/karma', '/unknown']) {
      const { deps, calls } = setup();
      const body = await (await handleTelegram(request(update(1, text)), deps)).json();
      expect(body.method).toBe('sendMessage');
      expect(body.chat_id).toBe(42);
      expect(body.text).toContain('Provider');
      expect(body.text).toContain('Consumer');
      expect(body.parse_mode).toBeUndefined();
      expect(calls).toHaveLength(0);
    }
  });
  test('looks up a profile using the same structured A2A message and preserves scores/confidence', async () => {
    const { deps, calls } = setup();
    const text = '/karma https://agentkarma.io/agent/0xCfc0A11C75519FAf85B7872E27733CFaa4295b96?chain=arc&agentId=72077';
    const body = await (await handleTelegram(request(update(1, text)), deps)).json();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ parts: [{ kind: 'data', data: { chain: 'arc', agentId: 72077 } }] });
    expect(body.text).toContain('Provider: 80/100');
    expect(body.text).toContain('Consumer: Unrated');
    expect(body.text).toContain('Declared');
    expect(body.text).toContain('https://agentkarma.io/agent/');
  });
  test('normalization errors explain recovery without querying', async () => {
    const { deps, calls } = setup();
    const body = await (await handleTelegram(request(update(1, 'agentId 66 on stellar')), deps)).json();
    expect(body.text).toContain('wallet address');
    expect(calls).toHaveLength(0);
  });
  test('duplicate and concurrent updates execute the query once', async () => {
    const { deps, calls } = setup();
    const body = update(1, 'agentId 9058 on celo');
    const responses = await Promise.all([handleTelegram(request(body), deps), handleTelegram(request(body), deps)]);
    expect(calls).toHaveLength(1);
    const data = await Promise.all(responses.map((r) => r.json()));
    expect(data.filter((d) => d.method === 'sendMessage')).toHaveLength(1);
  });
  test('rate limits use a Telegram user identifier and suppress rapid replies', async () => {
    const keys: string[] = [];
    const { deps, calls } = setup({ limit: async (key) => { keys.push(key); return { success: false }; } });
    const first = await (await handleTelegram(request(update()), deps)).json();
    expect(first.text).toContain('Wait a minute');
    expect(keys).toEqual(['telegram:42']);
    expect(await (await handleTelegram(request(update(2)), deps)).json()).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
  });
  test('resolver failures release the update for retry and do not leak exceptions', async () => {
    const { deps } = setup({ query: async () => { throw new Error('private token-bearing endpoint'); } });
    const body = update(1, 'agentId 9058 on celo');
    const response = await handleTelegram(request(body), deps);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private');
    expect(deps.updates.size).toBe(0);
    expect(deps.cooldowns.size).toBe(0);
  });
  test('rapid updates from one user cannot exhaust replay capacity for other users', async () => {
    const { deps } = setup();
    await handleTelegram(request(update()), deps);
    for (let id = 2; id < 2100; id++) await handleTelegram(request(update(id)), deps);
    const response = await handleTelegram(request(update(2100, '/start', 43)), deps);
    expect(response.status).toBe(200);
    expect((await response.json()).method).toBe('sendMessage');
    expect(deps.updates.size).toBeLessThanOrEqual(2);
  });
  test('a full completed replay cache remains bounded without disabling new requests', async () => {
    const { deps } = setup();
    for (let id = 1; id <= 2048; id++) deps.updates.set(id, 9000);
    const response = await handleTelegram(request(update(2049)), deps);
    expect(response.status).toBe(200);
    expect((await response.json()).method).toBe('sendMessage');
    expect(deps.updates.size).toBe(2048);
  });
  test('JSON-RPC errors inside HTTP 200 are retryable failures', async () => {
    const { deps } = setup({ query: async (id) => Response.json({ jsonrpc: '2.0', id, error: { code: -32603 } }) });
    expect((await handleTelegram(request(update(1, 'agentId 9058 on celo')), deps)).status).toBe(503);
    expect(deps.updates.size).toBe(0);
  });
  test('unknown agents return no-data text, never a made-up score', async () => {
    const { deps } = setup({ query: async (id) => Response.json({ jsonrpc: '2.0', id, result: { kind: 'message', role: 'agent', parts: [{ kind: 'text', text: 'No indexed activity found.' }, { kind: 'data', data: { found: false } }] } }) });
    const body = await (await handleTelegram(request(update(1, 'agentId 9058 on celo')), deps)).json();
    expect(body.text).toContain('No indexed activity');
    expect(body.text).not.toContain('/100');
  });
  test('invalid confidence labels cannot resolve inherited object properties', async () => {
    const { deps } = setup({ query: async (id) => Response.json({ jsonrpc: '2.0', id, result: { kind: 'message', role: 'agent', parts: [
      { kind: 'text', text: 'Result' }, { kind: 'data', data: { provider: { score: 80, confidenceBadge: 'constructor' }, consumer: { score: null, confidenceBadge: '__proto__' } } },
    ] } }) });
    const body = await (await handleTelegram(request(update(1, 'agentId 9058 on celo')), deps)).json();
    expect(body.text.match(/Confidence: Unavailable/g)).toHaveLength(2);
    expect(body.text).not.toContain('function');
  });
  test('expired replay entries permit a fresh query and expired cooldowns are reclaimed', async () => {
    let now = 10000;
    const { deps, calls } = setup({ now: () => now });
    const body = update(1, 'agentId 9058 on celo');
    await handleTelegram(request(body), deps);
    now += 600001;
    expect((await handleTelegram(request(body), deps)).status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(deps.updates.size).toBe(1);
    expect(deps.cooldowns.size).toBe(1);
  });
  test('a timed-out lookup frees its claim and active slot for retries', async () => {
    const { deps } = setup({ query: () => new Promise<Response>(() => {}) });
    const response = await handleTelegram(request(update(1, 'agentId 9058 on celo')), deps);
    expect(response.status).toBe(503);
    expect(deps.inFlight.size).toBe(0);
    expect(deps.updates.size).toBe(0);
    expect(deps.cooldowns.size).toBe(0);
  }, 15000);
  test('oversized no-data text remains bounded for Telegram', async () => {
    const { deps } = setup({ query: async (id) => Response.json({ jsonrpc: '2.0', id, result: { kind: 'message', role: 'agent', parts: [
      { kind: 'text', text: 'Unknown '.repeat(1000) }, { kind: 'data', data: { found: false } },
    ] } }) });
    const body = await (await handleTelegram(request(update(1, 'agentId 9058 on celo')), deps)).json();
    expect(body.text.length).toBeLessThanOrEqual(4096);
    expect(body.parse_mode).toBeUndefined();
  });
  test('failed concurrent attempts can be retried successfully without retaining failure', async () => {
    const { deps, calls } = setup();
    const goodQuery = deps.query;
    deps.query = async () => { throw new Error('unavailable'); };
    const body = update(1, 'agentId 9058 on celo');
    const first = await Promise.all([handleTelegram(request(body), deps), handleTelegram(request(body), deps)]);
    expect(first.some((r) => r.status === 503)).toBe(true);
    deps.query = goodQuery;
    const retry = await handleTelegram(request(body), deps);
    expect((await retry.json()).method).toBe('sendMessage');
    expect(calls).toHaveLength(1);
  });
});
