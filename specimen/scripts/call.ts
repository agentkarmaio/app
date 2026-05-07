/**
 * Specimen consumer — single x402 round-trip.
 *
 *   1. GET /<resource>                       → 402 + PaymentRequirements
 *   2. build USDC transfer with bound memo   → sign + send + confirm
 *   3. GET /<resource> with payment headers  → 200 + payload
 *
 * Usage:
 *   bun run specimen:call               # /echo against $SPECIMEN_BASE_URL
 *   bun run specimen:call quote         # /quote
 *
 * Env:
 *   SPECIMEN_BASE_URL          default http://localhost:3941
 *   HELIUS_RPC_URL             required (used as Solana Connection RPC)
 *   SPECIMEN_CONSUMER_KEY      path to keypair JSON (default web/.keys/specimen-consumer.json)
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

import { HEADERS, type PaymentRequirements } from '../../src/lib/specimen/protocol';
import { buildUsdcPayment } from '../../src/lib/specimen/usdc';

const RESOURCE = process.argv[2] ?? 'echo';
const BASE_URL = process.env.SPECIMEN_BASE_URL ?? 'http://localhost:3941';
const RPC_URL = process.env.HELIUS_RPC_URL ?? process.env.SOLANA_RPC_URL;
const KEY_PATH = process.env.SPECIMEN_CONSUMER_KEY
  ?? resolve(process.cwd(), '.keys/specimen-consumer.json');

if (!RPC_URL) {
  console.error('[call] HELIUS_RPC_URL (or SOLANA_RPC_URL) required');
  process.exit(1);
}

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function fetchRequirements(resource: string): Promise<PaymentRequirements> {
  const res = await fetch(`${BASE_URL}/${resource}`);
  if (res.status !== 402) {
    throw new Error(`Expected 402, got ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as PaymentRequirements;
}

async function callWithPayment(
  resource: string,
  nonce: string,
  signature: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}/${resource}`, {
    headers: {
      [HEADERS.TX]: signature,
      [HEADERS.NONCE]: nonce,
      [HEADERS.RESOURCE]: resource,
    },
  });
  return { status: res.status, body: await res.json().catch(() => res.text()) };
}

async function main() {
  const consumer = loadKeypair(KEY_PATH);
  const connection = new Connection(RPC_URL!, 'confirmed');

  console.log(`[call] consumer: ${consumer.publicKey.toBase58()}`);
  console.log(`[call] target:   ${BASE_URL}/${RESOURCE}`);

  const reqs = await fetchRequirements(RESOURCE);
  console.log(`[call] 402 received. requirements:`, {
    recipient: reqs.recipient,
    amount:    reqs.amount,
    nonce:     reqs.nonce,
  });

  const { tx, memo } = await buildUsdcPayment({
    connection,
    payer: consumer,
    recipient: new PublicKey(reqs.recipient),
    amountUsdc: reqs.amount,
    resource: reqs.resource,
    nonce: reqs.nonce,
  });

  console.log(`[call] memo: ${memo}`);

  const signature = await connection.sendTransaction(tx, { maxRetries: 3 });
  console.log(`[call] tx sent: ${signature}`);

  const blockhash = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction(
    { signature, blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
    'confirmed',
  );
  console.log(`[call] tx confirmed`);

  // Helius indexer needs a beat to ingest the tx before /echo verification can find it.
  await new Promise((r) => setTimeout(r, 2000));

  const result = await callWithPayment(RESOURCE, reqs.nonce, signature);
  console.log(`[call] response status: ${result.status}`);
  console.log(JSON.stringify(result.body, null, 2));

  if (result.status !== 200) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[call] fatal:', err);
  process.exit(1);
});
