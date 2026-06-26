/// <reference types="bun-types" />
/**
 * POST /api/agent/prove — ownership-proof attach (SECURITY-CRITICAL).
 *
 * Mirrors the claim/evm test: real EIP-191 signatures from a deterministic viem
 * account exercise the signature gate against bytes a real wallet emits. The
 * happy path attaches proof to an existing row via a fake Supabase and asserts
 * ONLY the proof columns are written (no metadata wipe). A missing row → 404.
 */
import { describe, expect, test, afterEach, mock } from 'bun:test';
import { privateKeyToAccount } from 'viem/accounts';
import { __setSupabaseForTest } from '@/db/client';
import { POST } from './route';

function req(body: unknown): Request {
  return new Request('http://localhost/api/agent/prove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const account = privateKeyToAccount(`0x${'07'.repeat(32)}`);
const lower = account.address.toLowerCase();
const ts = Date.now();
const message = `AgentKarma: Claim wallet ${lower} at ${ts}`;
const signature = await account.signMessage({ message });

function makeFakeSupabase(captured: Array<Record<string, unknown>>, existing: unknown) {
  return {
    from() {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.single = async () =>
        existing ? { data: existing, error: null } : { data: null, error: { code: 'PGRST116' } };
      b.maybeSingle = async () => ({ data: existing, error: null });
      b.update = (rows: Record<string, unknown>) => {
        captured.push(rows);
        const chain: Record<string, unknown> = {};
        chain.eq = () => chain;
        chain.then = (resolve: (v: { error: null }) => void) => resolve({ error: null });
        return chain;
      };
      return b;
    },
  };
}

describe('POST /api/agent/prove — guards', () => {
  test('missing fields → 400', async () => {
    expect((await POST(req({ address: lower, chain: 'celo' }) as never)).status).toBe(400);
  });

  test('invalid chain → 400', async () => {
    const res = await POST(req({ address: lower, chain: 'bogus', signature, message }) as never);
    expect(res.status).toBe(400);
  });

  test('expired timestamp → 400', async () => {
    const oldTs = ts - 10 * 60 * 1000;
    const oldMsg = `AgentKarma: Claim wallet ${lower} at ${oldTs}`;
    const oldSig = await account.signMessage({ message: oldMsg });
    const res = await POST(req({ address: lower, chain: 'celo', signature: oldSig, message: oldMsg }) as never);
    expect(res.status).toBe(400);
  });

  test('bad signature (different key) → 401', async () => {
    const other = privateKeyToAccount(`0x${'08'.repeat(32)}`);
    const badSig = await other.signMessage({ message });
    const res = await POST(req({ address: lower, chain: 'celo', signature: badSig, message }) as never);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/agent/prove — attach', () => {
  let captured: Array<Record<string, unknown>>;
  afterEach(() => { __setSupabaseForTest(null); mock.restore(); });

  test('valid proof on existing row → 200, writes ONLY proof columns', async () => {
    captured = [];
    __setSupabaseForTest(
      makeFakeSupabase(captured, { chain: 'celo', address: lower, claimed: true, claimed_at: '2026-01-01T00:00:00Z', display_name: 'Keep Me' }),
    );
    const res = await POST(req({ address: account.address, chain: 'celo', signature, message }) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.proofRecorded).toBe(true);
    expect(json.address).toBe(lower);

    const row = captured[0];
    expect(row.claim_signature).toBe(signature);
    expect(row.claim_message).toBe(message);
    // Metadata must NOT be touched by a prove (no wipe).
    expect('display_name' in row).toBe(false);
    expect('description' in row).toBe(false);
    expect('tempo_address' in row).toBe(false);
  });

  test('no matching row → 404', async () => {
    captured = [];
    __setSupabaseForTest(makeFakeSupabase(captured, null));
    const res = await POST(req({ address: account.address, chain: 'celo', signature, message }) as never);
    expect(res.status).toBe(404);
  });
});
