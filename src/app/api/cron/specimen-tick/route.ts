/**
 * POST /api/cron/specimen-tick
 *
 * Fires one specimen x402 round-trip from the consumer wallet to the
 * specimen agent. Scheduled by `servel job` so the full pipeline keeps
 * exercising on-chain state through the hackathon window.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` required.
 *
 * Env:
 *   CRON_SECRET                       shared secret with the cron scheduler
 *   SPECIMEN_CONSUMER_PRIVATE_KEY     JSON-array secret key bytes
 *   HELIUS_RPC_URL                    Solana RPC + Helius enhanced parsing
 *   NEXT_PUBLIC_APP_URL               own origin (default https://agentkarma.io)
 */

import { NextRequest, NextResponse } from 'next/server';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

import { HEADERS, type PaymentRequirements } from '@/lib/specimen/protocol';
import { buildUsdcPayment } from '@/lib/specimen/usdc';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const RESOURCES = ['echo', 'quote'] as const;

function loadKeypair(): Keypair | null {
  const raw = process.env.SPECIMEN_CONSUMER_PRIVATE_KEY;
  if (!raw) return null;
  try {
    const bytes = JSON.parse(raw) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const consumer = loadKeypair();
  if (!consumer) {
    return NextResponse.json(
      { error: 'SPECIMEN_CONSUMER_PRIVATE_KEY not configured' },
      { status: 500 },
    );
  }

  const rpcUrl = process.env.HELIUS_RPC_URL ?? process.env.SOLANA_RPC_URL;
  if (!rpcUrl) return NextResponse.json({ error: 'HELIUS_RPC_URL not set' }, { status: 500 });

  const origin = process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io';

  // Pick a resource. Round-robin via timestamp parity so consecutive ticks alternate.
  const resource = RESOURCES[Math.floor(Date.now() / 60_000) % RESOURCES.length];

  let body: { ok?: boolean; tickResource?: string; signature?: string; error?: string; status?: number; details?: unknown };
  try {
    const reqsRes = await fetch(`${origin}/api/specimen/${resource}`, { cache: 'no-store' });
    if (reqsRes.status !== 402) {
      return NextResponse.json(
        { error: 'requirements_unexpected_status', status: reqsRes.status },
        { status: 502 },
      );
    }
    const reqs = (await reqsRes.json()) as PaymentRequirements;

    const connection = new Connection(rpcUrl, 'confirmed');
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

    // Wait for Helius to ingest the tx so /echo can verify it.
    await new Promise((r) => setTimeout(r, 2500));

    const callRes = await fetch(`${origin}/api/specimen/${resource}`, {
      cache: 'no-store',
      headers: {
        [HEADERS.TX]: signature,
        [HEADERS.NONCE]: reqs.nonce,
        [HEADERS.RESOURCE]: resource,
      },
    });

    body = {
      ok: callRes.ok,
      tickResource: resource,
      signature,
      status: callRes.status,
      details: await callRes.json().catch(() => null),
    };
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  return NextResponse.json(body, { status: body.ok ? 200 : 502 });
}
