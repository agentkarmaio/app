/**
 * Specimen consumer — long-running loop with jittered intervals.
 *
 * Picks /echo or /quote round-robin, executes a full x402 round-trip,
 * then sleeps for `interval ± jitter`. Logs each call with sig + status.
 *
 * Designed for `nohup bun run web/specimen/scripts/cron.ts &` over the
 * 5-day hackathon window. Crash-tolerant: errors get logged, loop continues.
 *
 * Args:
 *   --interval=<sec>     mean delay between calls (default 1800 = 30 min)
 *   --jitter=<sec>       random ± window (default 600 = 10 min)
 *   --max=<count>        stop after N calls (default Infinity)
 *   --until=<iso8601>    stop after this timestamp (default Infinity)
 *
 * Env: same as call.ts.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

import { HEADERS, type PaymentRequirements } from '../../src/lib/specimen/protocol';
import { buildUsdcPayment } from '../../src/lib/specimen/usdc';

const BASE_URL = process.env.SPECIMEN_BASE_URL ?? 'http://localhost:3941';
const RPC_URL = process.env.HELIUS_RPC_URL ?? process.env.SOLANA_RPC_URL;
const KEY_PATH = process.env.SPECIMEN_CONSUMER_KEY
  ?? resolve(process.cwd(), '.keys/specimen-consumer.json');

if (!RPC_URL) {
  console.error('[cron] HELIUS_RPC_URL required');
  process.exit(1);
}

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const INTERVAL_SEC = Number(arg('interval', '1800'));
const JITTER_SEC   = Number(arg('jitter', '600'));
const MAX_CALLS    = Number(arg('max', 'Infinity'));
const UNTIL        = arg('until', '');
const UNTIL_MS     = UNTIL ? new Date(UNTIL).getTime() : Infinity;

const RESOURCES = ['echo', 'quote'] as const;

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function jitteredDelayMs(): number {
  const offsetSec = (Math.random() * 2 - 1) * JITTER_SEC;
  return Math.max(1000, (INTERVAL_SEC + offsetSec) * 1000);
}

function ts(): string {
  return new Date().toISOString();
}

async function fireOnce(connection: Connection, consumer: Keypair, resource: string): Promise<void> {
  const reqsRes = await fetch(`${BASE_URL}/${resource}`);
  if (reqsRes.status !== 402) {
    console.error(`[${ts()}] requirements fetch returned ${reqsRes.status}`);
    return;
  }
  const reqs = (await reqsRes.json()) as PaymentRequirements;

  const { tx } = await buildUsdcPayment({
    connection,
    payer: consumer,
    recipient: new PublicKey(reqs.recipient),
    amountUsdc: reqs.amount,
    resource: reqs.resource,
    nonce: reqs.nonce,
  });

  const signature = await connection.sendTransaction(tx, { maxRetries: 3 });
  const blockhash = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction(
    { signature, blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
    'confirmed',
  );

  await new Promise((r) => setTimeout(r, 2500));

  const callRes = await fetch(`${BASE_URL}/${resource}`, {
    headers: {
      [HEADERS.TX]: signature,
      [HEADERS.NONCE]: reqs.nonce,
      [HEADERS.RESOURCE]: resource,
    },
  });

  console.log(
    `[${ts()}] ${resource} sig=${signature.slice(0, 12)}… amount=${reqs.amount} status=${callRes.status}`,
  );

  if (callRes.status !== 200) {
    const body = await callRes.text();
    console.error(`[${ts()}] body: ${body}`);
  }
}

async function main() {
  const consumer = loadKeypair(KEY_PATH);
  const connection = new Connection(RPC_URL!, 'confirmed');

  console.log(`[cron] consumer: ${consumer.publicKey.toBase58()}`);
  console.log(`[cron] target:   ${BASE_URL}`);
  console.log(`[cron] interval: ${INTERVAL_SEC}s ± ${JITTER_SEC}s`);
  if (Number.isFinite(MAX_CALLS)) console.log(`[cron] max calls: ${MAX_CALLS}`);
  if (Number.isFinite(UNTIL_MS))  console.log(`[cron] until:     ${UNTIL}`);

  let count = 0;
  let resourceIdx = 0;

  while (count < MAX_CALLS && Date.now() < UNTIL_MS) {
    const resource = RESOURCES[resourceIdx % RESOURCES.length];
    resourceIdx++;
    count++;

    try {
      await fireOnce(connection, consumer, resource);
    } catch (err) {
      console.error(`[${ts()}] fireOnce error:`, err instanceof Error ? err.message : err);
    }

    if (count >= MAX_CALLS || Date.now() >= UNTIL_MS) break;

    const delay = jitteredDelayMs();
    console.log(`[${ts()}] sleeping ${(delay / 1000).toFixed(0)}s (next call ~${new Date(Date.now() + delay).toISOString()})`);
    await new Promise((r) => setTimeout(r, delay));
  }

  console.log(`[cron] done. fired ${count} calls.`);
}

main().catch((err) => {
  console.error('[cron] fatal:', err);
  process.exit(1);
});
