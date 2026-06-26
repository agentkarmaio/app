/// <reference types="bun-types" />
/**
 * POST /api/agent/claim/evm — signature gate (SECURITY-CRITICAL).
 *
 * Guard cases return BEFORE any DB write (no DB/network needed). Fixtures are
 * real EIP-191 personal_sign signatures from a deterministic viem account — the
 * exact primitive Rabby / MetaMask produce — so the route's recoverMessageAddress
 * gate is exercised against bytes a real wallet emits, not a placeholder.
 *
 * The happy path (valid sig → 200 off-chain claim) runs against a fake Supabase.
 * On-chain 8004 registration stays PENDING — register must be agent-signed, not
 * minted with AK's validator key.
 */
import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { privateKeyToAccount } from 'viem/accounts';
import { __setSupabaseForTest } from '@/db/client';
import { metadataHash, bindMetadata } from '@/lib/claim-challenge';
import { POST } from './route';

function req(body: unknown): Request {
  return new Request('http://localhost/api/agent/claim/evm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const account = privateKeyToAccount(`0x${'07'.repeat(32)}`);
const address = account.address; // checksummed 0x…
const ts = Date.now();
// Bare (unbound) message — guards return before the metadata-binding check.
const message = `AgentKarma: Claim wallet ${address} at ${ts}`;
const signature = await account.signMessage({ message });

/** Build a metadata-bound claim message + a real signature over it. */
async function signedClaim(
  addr: string,
  meta: { displayName: string; description?: string | null; website?: string | null; category?: string | null; imageUrl?: string | null },
  t: number = Date.now(),
) {
  const m = bindMetadata(
    `AgentKarma: Claim wallet ${addr} at ${t}`,
    await metadataHash({
      displayName: meta.displayName,
      description: meta.description ?? null,
      website: meta.website ?? null,
      category: meta.category ?? null,
      imageUrl: meta.imageUrl ?? null,
    }),
  );
  return { message: m, signature: await account.signMessage({ message: m }) };
}

describe('POST /api/agent/claim/evm — guards', () => {
  test('missing required fields → 400', async () => {
    const res = await POST(req({ address, chain: 'celo' }) as never);
    expect(res.status).toBe(400);
  });

  test('invalid JSON body → 400', async () => {
    const bad = new Request('http://localhost/api/agent/claim/evm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    const res = await POST(bad as never);
    expect(res.status).toBe(400);
  });

  test('unsupported chain → 400', async () => {
    const res = await POST(
      req({ address, chain: 'solana', displayName: 'x', signature, message }) as never,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/chain must be/i);
  });

  test('junk address → 400', async () => {
    const res = await POST(
      req({ address: 'not-a-wallet', chain: 'celo', displayName: 'x', signature, message }) as never,
    );
    expect(res.status).toBe(400);
  });

  test('expired timestamp (outside 5-min window) → 400', async () => {
    const oldTs = ts - 10 * 60 * 1000;
    const oldMsg = `AgentKarma: Claim wallet ${address} at ${oldTs}`;
    const oldSig = await account.signMessage({ message: oldMsg });
    const res = await POST(
      req({ address, chain: 'celo', displayName: 'x', signature: oldSig, message: oldMsg }) as never,
    );
    expect(res.status).toBe(400);
  });

  test('mismatched message (address not in challenge) → 400', async () => {
    const other = privateKeyToAccount(`0x${'08'.repeat(32)}`).address;
    const wrongMsg = `AgentKarma: Claim wallet ${other} at ${ts}`;
    const res = await POST(
      req({ address, chain: 'celo', displayName: 'x', signature, message: wrongMsg }) as never,
    );
    expect(res.status).toBe(400);
  });

  test('bad signature (signed by a different key) → 401', async () => {
    const other = privateKeyToAccount(`0x${'08'.repeat(32)}`);
    const badSig = await other.signMessage({ message });
    const res = await POST(
      req({ address, chain: 'celo', displayName: 'x', signature: badSig, message }) as never,
    );
    expect(res.status).toBe(401);
  });

  test('tampered message with otherwise-valid signature → 401', async () => {
    const tamperedMsg = `${message} `; // trailing space → recovers a different signer
    const res = await POST(
      req({ address, chain: 'celo', displayName: 'x', signature, message: tamperedMsg }) as never,
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /api/agent/claim/evm — honest claim write', () => {
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

  test('valid claim → 200, lowercased address, on-chain registration PENDING', async () => {
    const { message: m, signature: s } = await signedClaim(address, { displayName: 'My Agent' });
    const res = await POST(
      req({ address, chain: 'celo', displayName: 'My Agent', signature: s, message: m }) as never,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.claimed).toBe(true);
    expect(json.displayName).toBe('My Agent');
    expect(json.chain).toBe('celo');
    expect(json.address).toBe(address.toLowerCase());
    expect(json.onChainRegistration).toBe('pending');
    expect(captured).toContain('wallets.insert');
  });

  test('checksum-insensitive: lowercase address + matching message verifies → 200', async () => {
    // Real banner flow: walletAddress is the DB lowercase key, the message
    // embeds it verbatim, the wallet (checksummed account) signs it. The route
    // recovers the checksummed signer; getAddress on both sides clears the gate.
    const lower = address.toLowerCase();
    const { message: m, signature: s } = await signedClaim(lower, { displayName: 'Lower' });
    const res = await POST(
      req({ address: lower, chain: 'arc', displayName: 'Lower', signature: s, message: m }) as never,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).chain).toBe('arc');
  });

  test('valid signature but body metadata differs from the binding → 401', async () => {
    const { message: m, signature: s } = await signedClaim(address, { displayName: 'Honest Name' });
    // Replayed signature, attacker swaps the displayName in the body.
    const res = await POST(
      req({ address, chain: 'celo', displayName: 'PWNED', signature: s, message: m }) as never,
    );
    expect(res.status).toBe(401);
  });
});
