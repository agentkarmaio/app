/// <reference types="bun-types" />
/**
 * POST /api/agent/claim (Solana) — signature gate + metadata binding
 * (SECURITY-CRITICAL). This route has the widest binding surface: it commits to
 * the six identity fields AND the optional succession plan, so a replayed
 * signature can neither overwrite the profile nor smuggle an attacker-chosen
 * heir. Real Ed25519 signatures from a deterministic tweetnacl keypair exercise
 * the verifier against bytes a real Solana wallet emits.
 */
import { describe, expect, test, afterEach, mock } from 'bun:test';
import nacl from 'tweetnacl';
import { __setSupabaseForTest } from '@/db/client';
import { uint8ArrayToBase58 } from '@/lib/base58';
import { metadataHash, bindMetadata } from '@/lib/claim-challenge';
import { POST } from './route';

function req(body: unknown): Request {
  return new Request('http://localhost/api/agent/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const address = uint8ArrayToBase58(kp.publicKey); // base58 Solana pubkey

type ClaimMeta = {
  displayName: string;
  description?: string | null;
  website?: string | null;
  category?: string | null;
  imageUrl?: string | null;
  tempoAddress?: string | null;
  succession?: unknown;
};

/** Build a metadata-bound Solana claim message + a real Ed25519 signature. */
async function signedClaim(meta: ClaimMeta, t: number = Date.now()) {
  const message = bindMetadata(
    `AgentKarma: Claim wallet ${address} at ${t}`,
    await metadataHash({
      displayName: meta.displayName,
      description: meta.description ?? null,
      website: meta.website ?? null,
      category: meta.category ?? null,
      imageUrl: meta.imageUrl ?? null,
      tempoAddress: meta.tempoAddress ?? null,
      succession: meta.succession,
    }),
  );
  const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
  return { message, signature: uint8ArrayToBase58(sig) };
}

describe('POST /api/agent/claim (solana) — guards', () => {
  afterEach(() => { __setSupabaseForTest(null); mock.restore(); });

  test('missing fields → 400', async () => {
    expect((await POST(req({ address }) as never)).status).toBe(400);
  });

  test('bad signature (different key) → 401', async () => {
    const { message } = await signedClaim({ displayName: 'X' });
    const other = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
    const badSig = uint8ArrayToBase58(nacl.sign.detached(new TextEncoder().encode(message), other.secretKey));
    const res = await POST(req({ address, displayName: 'X', signature: badSig, message }) as never);
    expect(res.status).toBe(401);
  });

  test('replay with swapped displayName → 401 (identity binding)', async () => {
    const { message, signature } = await signedClaim({ displayName: 'Honest Name' });
    const res = await POST(req({ address, displayName: 'PWNED', signature, message }) as never);
    expect(res.status).toBe(401);
  });

  test('replay with swapped logo → 401 (Solana-only imageUrl binding)', async () => {
    const { message, signature } = await signedClaim({ displayName: 'X', imageUrl: 'https://good.example/a.png' });
    const res = await POST(
      req({ address, displayName: 'X', imageUrl: 'https://evil.example/b.png', signature, message }) as never,
    );
    expect(res.status).toBe(401);
  });

  test('replay injecting an attacker succession plan → 401 (succession binding)', async () => {
    // Owner signed a claim with NO succession; attacker replays it with a plan
    // naming themselves heir. The plan is bound, so the binding rejects it
    // (BEFORE any DB write / succession declaration).
    const { message, signature } = await signedClaim({ displayName: 'X' });
    const res = await POST(
      req({
        address,
        displayName: 'X',
        succession: { intervalSeconds: 3600, heirs: [{ address: 'ATTACKER', chain: 'solana' }] },
        signature,
        message,
      }) as never,
    );
    expect(res.status).toBe(401);
  });
});

// Note: the bound-write happy path (200 + insert) is intentionally not unit-tested
// here — it depends on claimWallet + the fire-and-forget enqueueWalletScan, whose
// unawaited promise races test teardown (flaky). Acceptance of a correctly-bound
// claim is covered deterministically by the evm/stellar happy paths and
// claim-challenge.test.ts (messageBindsMetadata returns true for matching fields);
// the guards above lock the security-critical rejection paths, which return at the
// binding check before any DB write.
