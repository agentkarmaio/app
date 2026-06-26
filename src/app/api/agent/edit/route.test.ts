/// <reference types="bun-types" />
/**
 * POST /api/agent/edit — claimed-agent metadata editor (SECURITY-CRITICAL).
 *
 * Mirrors the prove test: real EIP-191 signatures from a deterministic viem
 * account exercise the signature gate against bytes a real wallet emits. The
 * happy path full-replaces metadata on an existing CLAIMED row via a fake
 * Supabase and asserts the editable columns are written + the proof is refreshed
 * (but claimed/claimed_at are never touched). An unclaimed row → 409, no row →
 * 404, a private-IP logo URL → 422 (before the signature even matters).
 */
import { describe, expect, test, afterEach, mock } from 'bun:test';
import { privateKeyToAccount } from 'viem/accounts';
import { __setSupabaseForTest } from '@/db/client';
import { POST } from './route';

function req(body: unknown): Request {
  return new Request('http://localhost/api/agent/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const account = privateKeyToAccount(`0x${'07'.repeat(32)}`);
const lower = account.address.toLowerCase();
const ts = Date.now();
const message = `AgentKarma: Edit wallet ${lower} at ${ts}`;
const signature = await account.signMessage({ message });
// The publicly-displayed claim/prove receipt — must NOT authorize an edit.
const claimMessage = `AgentKarma: Claim wallet ${lower} at ${ts}`;
const claimSignature = await account.signMessage({ message: claimMessage });

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

const claimedRow = {
  chain: 'celo',
  address: lower,
  claimed: true,
  claimed_at: '2026-01-01T00:00:00Z',
  display_name: 'Old Name',
};

describe('POST /api/agent/edit — guards', () => {
  afterEach(() => { __setSupabaseForTest(null); mock.restore(); });

  test('missing fields → 400', async () => {
    expect((await POST(req({ address: lower, chain: 'celo' }) as never)).status).toBe(400);
  });

  test('invalid chain → 400', async () => {
    const res = await POST(req({ address: lower, chain: 'bogus', displayName: 'X', signature, message }) as never);
    expect(res.status).toBe(400);
  });

  test('displayName too long → 400', async () => {
    const res = await POST(
      req({ address: account.address, chain: 'celo', displayName: 'x'.repeat(51), signature, message }) as never,
    );
    expect(res.status).toBe(400);
  });

  test('private-IP logo URL with valid signature → 422 (SSRF guard runs after auth)', async () => {
    const res = await POST(
      req({
        address: account.address,
        chain: 'celo',
        displayName: 'X',
        imageUrl: 'http://127.0.0.1/logo.png',
        signature,
        message,
      }) as never,
    );
    expect(res.status).toBe(422);
  });

  test('bad imageUrl with INVALID signature → 401, not 422 (no pre-auth DNS)', async () => {
    const other = privateKeyToAccount(`0x${'08'.repeat(32)}`);
    const badSig = await other.signMessage({ message });
    const res = await POST(
      req({
        address: lower,
        chain: 'celo',
        displayName: 'X',
        imageUrl: 'http://attacker.example/probe',
        signature: badSig,
        message,
      }) as never,
    );
    expect(res.status).toBe(401);
  });

  test('claim-challenge signature does NOT authorize an edit → 400 (operation-scoped)', async () => {
    const res = await POST(
      req({ address: account.address, chain: 'celo', displayName: 'X', signature: claimSignature, message: claimMessage }) as never,
    );
    expect(res.status).toBe(400); // wrong verb ("Claim" ≠ "Edit") → Invalid message format
  });

  test('expired timestamp → 400', async () => {
    const oldTs = ts - 10 * 60 * 1000;
    const oldMsg = `AgentKarma: Edit wallet ${lower} at ${oldTs}`;
    const oldSig = await account.signMessage({ message: oldMsg });
    const res = await POST(
      req({ address: lower, chain: 'celo', displayName: 'X', signature: oldSig, message: oldMsg }) as never,
    );
    expect(res.status).toBe(400);
  });

  test('bad signature (different key) → 401', async () => {
    const other = privateKeyToAccount(`0x${'08'.repeat(32)}`);
    const badSig = await other.signMessage({ message });
    const res = await POST(
      req({ address: lower, chain: 'celo', displayName: 'X', signature: badSig, message }) as never,
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /api/agent/edit — update', () => {
  let captured: Array<Record<string, unknown>>;
  afterEach(() => { __setSupabaseForTest(null); mock.restore(); });

  test('valid edit on claimed row → 200, full-replace + refreshes proof', async () => {
    captured = [];
    __setSupabaseForTest(makeFakeSupabase(captured, claimedRow));
    const res = await POST(
      req({
        address: account.address,
        chain: 'celo',
        displayName: 'New Name',
        description: 'fresh desc',
        imageUrl: 'http://1.1.1.1/logo.png', // public literal IP → sync pass, no DNS
        signature,
        message,
      }) as never,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.updated).toBe(true);
    expect(json.address).toBe(lower);

    const row = captured[0];
    expect(row.display_name).toBe('New Name');
    expect(row.description).toBe('fresh desc');
    expect(row.image_url).toBe('http://1.1.1.1/logo.png');
    // Edit must NOT persist its signature into the public claim receipt
    // (it would become a replayable edit-authorizer).
    expect('claim_signature' in row).toBe(false);
    expect('claim_message' in row).toBe(false);
    // Edit must NOT re-flip claim state or reset claim time.
    expect('claimed' in row).toBe(false);
    expect('claimed_at' in row).toBe(false);
    // EVM edit omits tempo entirely (Solana-only).
    expect('tempo_address' in row).toBe(false);
  });

  test('blank optional fields clear them (full-replace → null)', async () => {
    captured = [];
    __setSupabaseForTest(makeFakeSupabase(captured, claimedRow));
    const res = await POST(
      req({ address: account.address, chain: 'celo', displayName: 'Only Name', signature, message }) as never,
    );
    expect(res.status).toBe(200);
    const row = captured[0];
    expect(row.description).toBe(null);
    expect(row.website).toBe(null);
    expect(row.category).toBe(null);
    expect(row.image_url).toBe(null);
  });

  test('row exists but is unclaimed → 409', async () => {
    captured = [];
    __setSupabaseForTest(makeFakeSupabase(captured, { ...claimedRow, claimed: false }));
    const res = await POST(
      req({ address: account.address, chain: 'celo', displayName: 'X', signature, message }) as never,
    );
    expect(res.status).toBe(409);
    expect(captured.length).toBe(0); // no write attempted
  });

  test('no matching row → 404', async () => {
    captured = [];
    __setSupabaseForTest(makeFakeSupabase(captured, null));
    const res = await POST(
      req({ address: account.address, chain: 'celo', displayName: 'X', signature, message }) as never,
    );
    expect(res.status).toBe(404);
  });
});
