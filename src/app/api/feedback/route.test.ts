/// <reference types="bun-types" />
/**
 * POST /api/feedback must only accept a rating from the payer of the referenced
 * transaction for the PAYEE of that transaction. Before this test, the route
 * verified the payer's signature but ignored which wallet the tx paid, so a
 * payer could attach a rating to any agent.
 *
 * Run: bun test src/app/api/feedback/route.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import nacl from 'tweetnacl';
import { PublicKey } from '@solana/web3.js';
import * as db from '@/db/client';
import { POST } from './route';

afterEach(() => db.__setSupabaseForTest(null));

const payerKeys = nacl.sign.keyPair();
const PAYER = new PublicKey(payerKeys.publicKey).toBase58();
const AGENT = new PublicKey(nacl.sign.keyPair().publicKey).toBase58();
const OTHER = new PublicKey(nacl.sign.keyPair().publicKey).toBase58();

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58(bytes: Uint8Array): string {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}

function fakeDb(tx: Record<string, unknown>, inserts: unknown[]) {
  db.__setSupabaseForTest({ from(table: string) {
    const builder: Record<string, unknown> = {
      select: () => builder, eq: () => builder, limit: () => builder,
      single: async () => (table === 'transactions' ? { data: tx, error: null } : { data: null, error: { code: 'PGRST116' } }),
      then: (resolve: (v: unknown) => void) => Promise.resolve(resolve({ data: [], error: null })),
      insert: (row: unknown) => { inserts.push(row); return Promise.resolve({ error: null }); },
    };
    return builder;
  } });
}

function request(agentWallet: string) {
  const txSignature = 'sig-1';
  const message = `AgentKarma: Feedback delivered for ${txSignature} at ${Date.now()}`;
  const signature = bs58(nacl.sign.detached(new TextEncoder().encode(message), payerKeys.secretKey));
  return new NextRequest('https://agentkarma.io/api/feedback', {
    method: 'POST',
    body: JSON.stringify({ agentWallet, rating: 'delivered', txSignature, signature, message }),
  });
}

describe('POST /api/feedback payee check', () => {
  test('accepts the payer rating the agent its tx paid', async () => {
    const inserts: unknown[] = [];
    fakeDb({ tx_signature: 'sig-1', wallet_address: PAYER, counterparty: AGENT }, inserts);
    const res = await POST(request(AGENT));
    expect(res.status).toBe(200);
    expect(inserts).toHaveLength(1);
  });

  test('rejects rating a wallet the tx did not pay — nothing is written', async () => {
    const inserts: unknown[] = [];
    fakeDb({ tx_signature: 'sig-1', wallet_address: PAYER, counterparty: OTHER }, inserts);
    const res = await POST(request(AGENT));
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe('tx_not_paid_to_agent');
    expect(inserts).toHaveLength(0);
  });

  test('rejects a tx with no recorded payee', async () => {
    const inserts: unknown[] = [];
    fakeDb({ tx_signature: 'sig-1', wallet_address: PAYER, counterparty: null }, inserts);
    const res = await POST(request(AGENT));
    expect(res.status).toBe(403);
    expect(inserts).toHaveLength(0);
  });
});
