import { describe, expect, test } from 'bun:test';
import { POST } from './route';

function request(body: string, headers: Record<string, string> = {}) {
  return new Request('http://localhost:3737/api/v2/collaboration', {
    method: 'POST',
    headers: { origin: 'http://localhost:3737', 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('collaboration request boundary (no outbound messages)', () => {
  test('accepts the public origin behind an internal reverse proxy URL', async () => {
    const response = await POST(new Request('http://0.0.0.0:3000/api/v2/collaboration', {
      method: 'POST', headers: { origin: 'https://agentkarma.io', 'content-type': 'application/json', 'x-real-ip': 'proxy-test' }, body: '{}',
    }));
    expect(response.status).toBe(400);
  });
  test('rejects cross-origin submissions', async () => {
    expect((await POST(request('{}', { origin: 'https://unrelated.example' }))).status).toBe(403);
  });
  test('rejects non-JSON submissions', async () => {
    expect((await POST(request('{}', { 'content-type': 'text/plain' }))).status).toBe(415);
  });
  test('rejects malformed JSON', async () => {
    expect((await POST(request('{', { 'x-real-ip': 'collaboration-json-test' }))).status).toBe(400);
  });
  test('rejects missing application fields', async () => {
    expect((await POST(request('{}', { 'x-real-ip': 'collaboration-fields-test' }))).status).toBe(400);
  });
  test('requires a nonempty Telegram username even when other fields are valid', async () => {
    const fields = { name: 'Validation test', email: 'test@example.com', project: 'Validation test', message: 'Validation only; this must not be delivered.' };
    for (const telegram of [undefined, '', '@', 'bad name']) {
      const response = await POST(request(JSON.stringify({ ...fields, telegram }), { 'x-real-ip': `telegram-required-${String(telegram)}` }));
      expect(response.status).toBe(400);
    }
  });
  test('rejects oversized payloads', async () => {
    expect((await POST(request(' '.repeat(12001), { 'x-real-ip': 'collaboration-size-test' }))).status).toBe(413);
  });
  test('limits repeated submissions', async () => {
    for (let i = 0; i < 3; i++) await POST(request('{}', { 'x-real-ip': 'collaboration-limit-test' }));
    const response = await POST(request('{}', { 'x-real-ip': 'collaboration-limit-test' }));
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
  });
});
