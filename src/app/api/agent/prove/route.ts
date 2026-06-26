import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { PublicKey } from '@solana/web3.js';
import { isChain, type Chain } from '@/db/schema';
import { setClaimProof } from '@/db/client';
import { buildClaimChallenge, verifyClaimSignature } from '@/lib/claim-verify';
import { isStellarAddress } from '@/lib/stellar-verify';

const CLAIM_WINDOW_MS = 5 * 60 * 1000;

/**
 * POST /api/agent/prove
 *
 * Attach a re-verifiable ownership proof to an ALREADY-CLAIMED agent whose
 * original claim-time signature was never retained (claims predating the
 * claim_signature column). Claiming already proved ownership at the time — this
 * route does not re-claim; it re-runs the SAME signature challenge purely to
 * capture and persist the receipt, touching NO identity metadata.
 *
 * Unified across chains: the challenge is byte-identical
 * (`AgentKarma: Claim wallet {address} at {ts}`) and `verifyClaimSignature`
 * dispatches to the native primitive per chain. EVM rows are keyed lowercase.
 *
 * Body: { address, chain, signature, message }
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { address, chain, signature, message } = body as {
    address?: string;
    chain?: string;
    signature?: string;
    message?: string;
  };

  if (!address || !chain || !signature || !message) {
    return NextResponse.json(
      { error: 'Missing required fields: address, chain, signature, message' },
      { status: 400 },
    );
  }
  if (!isChain(chain)) {
    return NextResponse.json({ error: 'Invalid chain' }, { status: 400 });
  }

  // Per-chain address validation + normalization (EVM rows are lowercase).
  let normalized: string;
  if (chain === 'celo' || chain === 'arc') {
    if (!isAddress(address)) {
      return NextResponse.json({ error: 'Invalid EVM wallet address' }, { status: 400 });
    }
    normalized = address.toLowerCase();
  } else if (chain === 'stellar') {
    if (!isStellarAddress(address)) {
      return NextResponse.json({ error: 'Invalid Stellar wallet address (G… only)' }, { status: 400 });
    }
    normalized = address;
  } else {
    try {
      new PublicKey(address);
    } catch {
      return NextResponse.json({ error: 'Invalid Solana wallet address' }, { status: 400 });
    }
    normalized = address;
  }

  // Challenge format: must embed the claimed address verbatim, with a fresh ts.
  const prefix = buildClaimChallenge(normalized, '');
  if (!message.startsWith(prefix)) {
    return NextResponse.json({ error: 'Invalid message format' }, { status: 400 });
  }
  const ts = Number(message.slice(prefix.length));
  if (Number.isNaN(ts) || Math.abs(Date.now() - ts) > CLAIM_WINDOW_MS) {
    return NextResponse.json({ error: 'Message timestamp expired (5 minute window)' }, { status: 400 });
  }

  // The signature gate — only the keyholder can attach a proof.
  if (!(await verifyClaimSignature(chain as Chain, normalized, message, signature))) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Attach the proof to the existing row (metadata untouched). No row → nothing
  // to prove ownership of: the agent must be indexed/claimed first.
  let recorded: boolean;
  try {
    recorded = await setClaimProof(normalized, chain as Chain, { signature, message });
  } catch (err) {
    console.error('[prove] DB error:', err);
    return NextResponse.json({ error: 'Failed to save proof' }, { status: 500 });
  }
  if (!recorded) {
    return NextResponse.json({ error: 'No claimable agent found for this address' }, { status: 404 });
  }

  return NextResponse.json({ success: true, address: normalized, chain, proofRecorded: true });
}
