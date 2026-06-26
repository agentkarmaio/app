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
import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { sha256 } from '@noble/hashes/sha2.js';
import { __setSupabaseForTest } from '@/db/client';
import { metadataHash, bindMetadata } from '@/lib/claim-challenge';
import { POST } from './route';

function req(body: unknown): Request {
  return new Request('http://localhost/api/agent/claim/stellar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Sign the way real Freighter (`@stellar/freighter-api` signMessage) does:
 * raw Ed25519 over the SEP-53 payload sha256("Stellar Signed Message:\n" || msg).
 * The fixtures MUST match the live wallet's primitive or the route's signature
 * gate is exercised against bytes no real client ever produces.
 */
function freighterSignHex(signer: Keypair, message: string): string {
  const prefix = new TextEncoder().encode('Stellar Signed Message:\n');
  const msg = new TextEncoder().encode(message);
  const payload = new Uint8Array(prefix.length + msg.length);
  payload.set(prefix, 0);
  payload.set(msg, prefix.length);
  return Buffer.from(signer.sign(Buffer.from(sha256(payload)))).toString('hex');
}

const kp = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
const address = kp.publicKey(); // G…
const C = StrKey.encodeContract(Buffer.alloc(32, 9)); // C… contract
const ts = Date.now();
// Bare (unbound) message — guards return before the metadata-binding check.
const message = `AgentKarma: Claim wallet ${address} at ${ts}`;
const signature = freighterSignHex(kp, message);

/** Build a metadata-bound claim message + a real Freighter-style signature. */
async function signedClaim(
  meta: { displayName: string; description?: string | null; website?: string | null; category?: string | null; imageUrl?: string | null },
  t: number = Date.now(),
) {
  const m = bindMetadata(
    `AgentKarma: Claim wallet ${address} at ${t}`,
    await metadataHash({
      displayName: meta.displayName,
      description: meta.description ?? null,
      website: meta.website ?? null,
      category: meta.category ?? null,
      imageUrl: meta.imageUrl ?? null,
    }),
  );
  return { message: m, signature: freighterSignHex(kp, m) };
}

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
    const oldSig = freighterSignHex(kp, oldMsg);
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
    const badSig = freighterSignHex(other, message);
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

/**
 * Honest on-chain-registration behavior (BUG 2 — silent false success).
 *
 * register_with_uri(caller, agent_uri) requires the AGENT to sign (caller is
 * both owner and agentWallet, contract.rs require_auth). AK cannot mint it with
 * its own validator key without binding agentWallet to AK and breaking spec §3
 * (payee == agentWallet). The route therefore MUST NOT run an AK-signed execute
 * mint, MUST NOT report on-chain success, and MUST report the on-chain 8004
 * registration as PENDING while the OFF-CHAIN claim still succeeds.
 */
describe('POST /api/agent/claim/stellar — honest on-chain registration', () => {
  // Minimal chainable Supabase fake: getWallet (insert path), claimWallet
  // insert, enqueueWalletScan select/upsert all resolve cleanly with no rows.
  function makeFakeSupabase(captured: string[]) {
    return {
      from(table: string) {
        const builder: Record<string, unknown> = {};
        builder.select = () => builder;
        builder.eq = () => builder;
        builder.single = async () => ({ data: null, error: { code: 'PGRST116' } });
        builder.maybeSingle = async () => ({ data: null, error: null });
        builder.insert = (rows: unknown) => {
          captured.push(`${table}.insert`);
          void rows;
          return Promise.resolve({ error: null });
        };
        builder.update = (rows: unknown) => {
          captured.push(`${table}.update`);
          void rows;
          const chain: Record<string, unknown> = {};
          chain.eq = () => chain;
          chain.then = (resolve: (v: { error: null }) => void) => resolve({ error: null });
          return chain;
        };
        builder.upsert = () => Promise.resolve({ error: null });
        return builder;
      },
    };
  }

  let captured: string[];
  beforeEach(() => {
    captured = [];
    __setSupabaseForTest(makeFakeSupabase(captured));
  });
  afterEach(() => {
    __setSupabaseForTest(null);
    mock.restore();
  });

  test('valid claim → 200, off-chain claimed, on-chain registration PENDING', async () => {
    const { message: m, signature: s } = await signedClaim({ displayName: 'My Agent' });
    const res = await POST(
      req({ address, displayName: 'My Agent', signature: s, message: m }) as never,
    );
    expect(res.status).toBe(200);
    const json = await res.json();

    // Off-chain claim succeeded.
    expect(json.success).toBe(true);
    expect(json.claimed).toBe(true);
    expect(json.displayName).toBe('My Agent');

    // On-chain 8004 registration is honestly reported as not-done — never a
    // false success, never a fabricated agentId.
    expect(json.onChainRegistration).toBe('pending');
    expect(json.stellarAgentId).toBeNull();
    expect(json.agentId ?? null).toBeNull();

    // The off-chain claim row was written; no agentId was persisted (no mint).
    expect(captured).toContain('wallets.insert');
    expect(captured.some((c) => c === 'wallets.update')).toBe(false);
  });

  test('does NOT invoke the AK-signed execute mint path', async () => {
    // If the route imported/called mintStellarAgentIdentity in execute mode, a
    // spy on the module would record a call. The honest route must not.
    const mintMod = await import('@/integrations/stellar-identity-mint');
    const spy = mock(mintMod.mintStellarAgentIdentity);
    mock.module('@/integrations/stellar-identity-mint', () => ({
      ...mintMod,
      mintStellarAgentIdentity: spy,
    }));

    const { message: m, signature: s } = await signedClaim({ displayName: 'My Agent' });
    const res = await POST(
      req({ address, displayName: 'My Agent', signature: s, message: m }) as never,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.onChainRegistration).toBe('pending');
    expect(json.stellarAgentId).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  test('valid signature but body metadata differs from the binding → 401', async () => {
    const { message: m, signature: s } = await signedClaim({ displayName: 'Honest Name' });
    const res = await POST(
      req({ address, displayName: 'PWNED', signature: s, message: m }) as never,
    );
    expect(res.status).toBe(401);
  });
});
