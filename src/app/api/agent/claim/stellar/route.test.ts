/// <reference types="bun-types" />
/**
 * POST /api/agent/claim/stellar — signature gate (SECURITY-CRITICAL).
 *
 * These four guard cases all return BEFORE any DB write or RPC mint, so the
 * test needs no DB/network. Fixtures are generated inline from a deterministic
 * Keypair / encodeContract (Correction C5) — no placeholder StrKeys.
 *
 * The happy path (valid sig → 200 + on-chain mint) requires DB + Soroban RPC
 * and is covered by manual/integration verification (plan Task 53), mirroring
 * the Solana claim route which ships no unit test for its write path.
 */
import { describe, expect, test } from 'bun:test';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { POST } from './route';

function req(body: unknown): Request {
  return new Request('http://localhost/api/agent/claim/stellar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const kp = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
const address = kp.publicKey(); // G…
const C = StrKey.encodeContract(Buffer.alloc(32, 9)); // C… contract
const ts = Date.now();
const message = `AgentKarma: Claim wallet ${address} at ${ts}`;
const signature = Buffer.from(kp.sign(Buffer.from(message))).toString('hex');

describe('POST /api/agent/claim/stellar — guards', () => {
  test('missing required fields → 400', async () => {
    const res = await POST(req({ address }) as never);
    expect(res.status).toBe(400);
  });

  test('invalid JSON body → 400', async () => {
    const bad = new Request('http://localhost/api/agent/claim/stellar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    const res = await POST(bad as never);
    expect(res.status).toBe(400);
  });

  test('C… smart wallet → 400 with explicit "G… Ed25519" message', async () => {
    const res = await POST(req({ address: C, displayName: 'x', signature, message }) as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/G…|Ed25519|smart wallet/i);
  });

  test('non-Stellar / junk address → 400', async () => {
    const res = await POST(
      req({ address: 'not-a-wallet', displayName: 'x', signature, message }) as never,
    );
    expect(res.status).toBe(400);
  });

  test('expired timestamp (outside 5-min window) → 400', async () => {
    const oldTs = ts - 10 * 60 * 1000;
    const oldMsg = `AgentKarma: Claim wallet ${address} at ${oldTs}`;
    const oldSig = Buffer.from(kp.sign(Buffer.from(oldMsg))).toString('hex');
    const res = await POST(
      req({ address, displayName: 'x', signature: oldSig, message: oldMsg }) as never,
    );
    expect(res.status).toBe(400);
  });

  test('mismatched message (address not in challenge) → 400', async () => {
    const otherAddr = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8)).publicKey();
    const wrongMsg = `AgentKarma: Claim wallet ${otherAddr} at ${ts}`;
    const res = await POST(
      req({ address, displayName: 'x', signature, message: wrongMsg }) as never,
    );
    expect(res.status).toBe(400);
  });

  test('bad signature (signed by a different key) → 401', async () => {
    const other = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8));
    const badSig = Buffer.from(other.sign(Buffer.from(message))).toString('hex');
    const res = await POST(
      req({ address, displayName: 'x', signature: badSig, message }) as never,
    );
    expect(res.status).toBe(401);
  });

  test('tampered message with otherwise-valid signature → 401', async () => {
    // message starts with the right prefix + valid ts, so it clears format/window
    // checks, but the signature was made over the untampered challenge → verify fails.
    const tamperedMsg = `${message} `; // trailing space — byte-different payload
    const res = await POST(
      req({ address, displayName: 'x', signature, message: tamperedMsg }) as never,
    );
    expect(res.status).toBe(401);
  });
});
