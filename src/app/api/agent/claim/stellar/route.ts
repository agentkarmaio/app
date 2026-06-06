import { NextRequest, NextResponse } from 'next/server';
import { claimWallet, enqueueWalletScan, setStellarAgentId } from '@/db/client';
import {
  verifyStellarClaimSignature,
  isStellarAddress,
  isStellarContractAddress,
} from '@/lib/stellar-verify';
import { mintStellarAgentIdentity } from '@/integrations/stellar-identity-mint';

const VALID_CATEGORIES = ['ai', 'data', 'defi', 'infra', 'social', 'utility', 'other'];
const CLAIM_WINDOW_MS = 5 * 60 * 1000;

/**
 * POST /api/agent/claim/stellar
 *
 * Claim a Stellar (G…) wallet to enrich its agent profile. Proves ownership
 * via a Freighter Ed25519 signature over the canonical challenge (byte-identical
 * to the Solana route), then mints the agent's stellar-8004 identity so on-chain
 * attestation (U3) is unblocked. C… smart wallets are rejected in v1 — they
 * authenticate via __check_auth, not a raw Ed25519 signature.
 *
 * Body:
 *   address:     string — G… Ed25519 wallet address
 *   displayName: string — agent display name (required, 1-50 chars)
 *   description: string — short description (optional, max 280 chars)
 *   website:     string — URL (optional)
 *   category:    string — one of VALID_CATEGORIES (optional)
 *   signature:   string — hex-encoded Ed25519 signature (Freighter signMessage)
 *   message:     string — the signed challenge (must match the expected format)
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { address, displayName, description, website, category, signature, message } = body as {
    address?: string;
    displayName?: string;
    description?: string;
    website?: string;
    category?: string;
    signature?: string;
    message?: string;
  };

  // Required fields
  if (!address || !displayName || !signature || !message) {
    return NextResponse.json(
      { error: 'Missing required fields: address, displayName, signature, message' },
      { status: 400 },
    );
  }

  // v1: reject C… smart wallets with an explicit message (different auth model).
  if (isStellarContractAddress(address)) {
    return NextResponse.json(
      { error: 'Only G… Ed25519 addresses are supported in v1 (smart wallets excluded).' },
      { status: 400 },
    );
  }
  if (!isStellarAddress(address)) {
    return NextResponse.json({ error: 'Invalid Stellar wallet address' }, { status: 400 });
  }

  // Metadata validation (mirrors the Solana route)
  if (displayName.length < 1 || displayName.length > 50) {
    return NextResponse.json({ error: 'displayName must be 1-50 characters' }, { status: 400 });
  }
  if (description && description.length > 280) {
    return NextResponse.json({ error: 'description must be 280 characters or less' }, { status: 400 });
  }
  if (category && !VALID_CATEGORIES.includes(category)) {
    return NextResponse.json(
      { error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` },
      { status: 400 },
    );
  }
  if (website) {
    try {
      new URL(website);
    } catch {
      return NextResponse.json({ error: 'website must be a valid URL' }, { status: 400 });
    }
  }

  // Challenge format: identical to Solana — "AgentKarma: Claim wallet {G…} at {ts}".
  const messagePrefix = `AgentKarma: Claim wallet ${address} at `;
  if (!message.startsWith(messagePrefix)) {
    return NextResponse.json({ error: 'Invalid message format' }, { status: 400 });
  }
  const messageTs = Number(message.slice(messagePrefix.length));
  if (Number.isNaN(messageTs) || Math.abs(Date.now() - messageTs) > CLAIM_WINDOW_MS) {
    return NextResponse.json({ error: 'Message timestamp expired (5 minute window)' }, { status: 400 });
  }

  // The signature gate — only the keyholder can claim. verify never throws.
  if (!verifyStellarClaimSignature(address, message, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Persist the claim (chain-scoped — U1's claimWallet takes a trailing chain arg).
  try {
    await claimWallet(
      address,
      displayName,
      description ?? null,
      website ?? null,
      category ?? null,
      null,
      'stellar',
    );
  } catch (err) {
    console.error('[claim:stellar] DB error:', err);
    return NextResponse.json({ error: 'Failed to save claim' }, { status: 500 });
  }

  // Mint the 8004 identity so U3 can attest on-chain. Non-fatal: the claim
  // succeeds even if the mint is deferred (badge-gated until agentId lands).
  // Surface mint failure in the response — no silent fallback (AK core rule).
  let stellarAgentId: number | null = null;
  let mintError: string | undefined;
  try {
    const mint = await mintStellarAgentIdentity(address, { mode: 'execute' });
    stellarAgentId = mint.agentId;
    if (stellarAgentId != null) {
      await setStellarAgentId(address, stellarAgentId);
    }
  } catch (err) {
    mintError = err instanceof Error ? err.message : 'mint failed';
    console.error('[claim:stellar] identity mint failed:', err);
  }

  // Trigger a regressive scan for the claimer's wallet — fire-and-forget,
  // idempotent (enqueueWalletScan dedups in_progress/cooldown/already_indexed).
  enqueueWalletScan(address).catch((err) => {
    console.error('[claim:stellar] enqueueWalletScan failed:', err);
  });

  return NextResponse.json({
    success: true,
    address,
    displayName,
    claimed: true,
    stellarAgentId,
    ...(mintError ? { mintError } : {}),
  });
}
