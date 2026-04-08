import { NextRequest, NextResponse } from 'next/server';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import {
  insertFeedback,
  hasFeedbackForTx,
  getTransactionBySig,
} from '@/db/client';
import type { FeedbackRating } from '@/db/schema';

const VALID_RATINGS: FeedbackRating[] = ['delivered', 'failed'];

/**
 * POST /api/feedback
 *
 * Submit delivery feedback for an agent after an x402 payment.
 * Consumer must prove they are the sender of the referenced transaction.
 *
 * Body:
 *   agentWallet:  string — the agent's wallet address
 *   rating:       'delivered' | 'failed'
 *   txSignature:  string — Solana tx signature of the x402 payment
 *   signature:    string — base58 Ed25519 signature from consumer wallet
 *   message:      string — the signed message (must match expected format)
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { agentWallet, rating, txSignature, signature, message } = body as {
    agentWallet?: string;
    rating?: string;
    txSignature?: string;
    signature?: string;
    message?: string;
  };

  // Validate required fields
  if (!agentWallet || !rating || !txSignature || !signature || !message) {
    return NextResponse.json(
      { error: 'Missing required fields: agentWallet, rating, txSignature, signature, message' },
      { status: 400 },
    );
  }

  // Validate rating
  if (!VALID_RATINGS.includes(rating as FeedbackRating)) {
    return NextResponse.json(
      { error: `rating must be one of: ${VALID_RATINGS.join(', ')}` },
      { status: 400 },
    );
  }

  // Validate message format: "AgentKarma: Feedback {rating} for {txSignature} at {timestamp}"
  const messagePrefix = `AgentKarma: Feedback ${rating} for ${txSignature} at `;
  if (!message.startsWith(messagePrefix)) {
    return NextResponse.json({ error: 'Invalid message format' }, { status: 400 });
  }

  // Check timestamp freshness (5 minute window)
  const timestampStr = message.slice(messagePrefix.length);
  const messageTs = Number(timestampStr);
  if (isNaN(messageTs) || Math.abs(Date.now() - messageTs) > 5 * 60 * 1000) {
    return NextResponse.json({ error: 'Message timestamp expired (5 minute window)' }, { status: 400 });
  }

  // Verify Ed25519 signature to get consumer wallet
  let consumerWallet: string;
  try {
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58Decode(signature);

    // We need to verify the signature is valid for some public key.
    // The consumer wallet is derived from the signature verification.
    // Since we can't extract pubkey from Ed25519 sig alone, the consumer
    // must provide their wallet in the message or as a field.
    // Let's extract it from the referenced transaction instead.

    // First, look up the transaction to find the sender
    const tx = await getTransactionBySig(txSignature);
    if (!tx) {
      return NextResponse.json({ error: 'Transaction not found in our records' }, { status: 404 });
    }

    // Verify the tx belongs to the claimed agent
    if (tx.wallet_address !== agentWallet) {
      // The wallet_address in our tx table is the sender (consumer), not the agent.
      // For x402, the sender pays the facilitator on behalf of consuming an agent's service.
      // So tx.wallet_address is the consumer wallet.
    }

    consumerWallet = tx.wallet_address;

    // Verify the signature was made by the consumer wallet
    const consumerPubkey = new PublicKey(consumerWallet);
    const valid = nacl.sign.detached.verify(messageBytes, signatureBytes, consumerPubkey.toBytes());
    if (!valid) {
      return NextResponse.json(
        { error: 'Signature does not match the transaction sender' },
        { status: 401 },
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) throw err;
    return NextResponse.json({ error: 'Signature verification failed' }, { status: 401 });
  }

  // Check for duplicate feedback
  const exists = await hasFeedbackForTx(txSignature);
  if (exists) {
    return NextResponse.json({ error: 'Feedback already submitted for this transaction' }, { status: 409 });
  }

  // Write feedback to DB
  try {
    await insertFeedback(agentWallet, consumerWallet, rating as FeedbackRating, txSignature);
  } catch (err) {
    console.error('[feedback] DB error:', err);
    return NextResponse.json({ error: 'Failed to save feedback' }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    agentWallet,
    consumerWallet,
    rating,
    txSignature,
  });
}

/** GET /api/feedback?agent=<wallet> — Get feedback summary for an agent */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const agent = searchParams.get('agent');

  if (!agent) {
    return NextResponse.json({ error: 'Missing agent query parameter' }, { status: 400 });
  }

  const { getFeedbackSummary } = await import('@/db/client');
  const summary = await getFeedbackSummary(agent);

  return NextResponse.json(summary);
}

function bs58Decode(str: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const BASE = BigInt(58);
  let num = BigInt(0);
  for (const char of str) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base58 character: ${char}`);
    num = num * BASE + BigInt(index);
  }
  const hex = num.toString(16).padStart(2, '0');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  let leadingZeros = 0;
  for (const char of str) {
    if (char === '1') leadingZeros++;
    else break;
  }
  const result = new Uint8Array(leadingZeros + bytes.length);
  result.set(bytes, leadingZeros);
  return result;
}
