import { NextRequest, NextResponse } from 'next/server';
import { claimWallet, enqueueWalletScan } from '@/db/client';
import {
  verifyStellarClaimSignature,
  isStellarAddress,
  isStellarContractAddress,
} from '@/lib/stellar-verify';
import { validateAgentMetadata, validateImageUrl } from '@/lib/agent-metadata';
import { messageBindsMetadata } from '@/lib/claim-challenge';
import { SsrfError } from '@/lib/ssrf-guard';

export const runtime = 'nodejs'; // validateImageUrl → SSRF guard needs node:dns/net

const CLAIM_WINDOW_MS = 5 * 60 * 1000;

/**
 * POST /api/agent/claim/stellar
 *
 * Claim a Stellar (G…) wallet to enrich its agent profile. Proves ownership
 * via a Freighter SEP-53 signature over the canonical challenge (byte-identical
 * to the Solana route). C… smart wallets are rejected in v1 — they authenticate
 * via __check_auth, not a raw Ed25519 signature.
 *
 * On-chain 8004 registration is reported as PENDING, not performed here. The
 * stellar-8004 register_with_uri(caller, agentURI) requires the AGENT to sign
 * (caller is both owner and agentWallet — contract.rs require_auth). AK cannot
 * mint it with its own validator key: that would bind agentWallet to AK and
 * break spec §3 (payee == agentWallet). Minting requires an agent-signed,
 * client-side register_with_uri (Freighter), tracked in the on-chain-write
 * milestone. Until then the claim succeeds OFF-CHAIN and the response honestly
 * marks `onChainRegistration: 'pending'` with a null agentId — never a false
 * on-chain success.
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

  const { address, displayName, description, website, category, imageUrl, signature, message } = body as {
    address?: string;
    displayName?: string;
    description?: string;
    website?: string;
    category?: string;
    imageUrl?: string | null;
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

  // Shared field validation (sync). No tempo on Stellar claims.
  const metaCheck = validateAgentMetadata({ displayName, description, website, category });
  if (!metaCheck.ok) {
    return NextResponse.json({ error: metaCheck.error }, { status: 400 });
  }

  // Challenge format: identical to Solana — "AgentKarma: Claim wallet {G…} at {ts}".
  const messagePrefix = `AgentKarma: Claim wallet ${address} at `;
  if (!message.startsWith(messagePrefix)) {
    return NextResponse.json({ error: 'Invalid message format' }, { status: 400 });
  }
  // parseInt (not Number) so the trailing " | sha256:…" binding doesn't poison it.
  const messageTs = parseInt(message.slice(messagePrefix.length), 10);
  if (Number.isNaN(messageTs) || Math.abs(Date.now() - messageTs) > CLAIM_WINDOW_MS) {
    return NextResponse.json({ error: 'Message timestamp expired (5 minute window)' }, { status: 400 });
  }

  // The signature gate — only the keyholder can claim. verify never throws.
  if (!verifyStellarClaimSignature(address, message, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Metadata binding: the signed message must commit to EXACTLY these fields, so
  // a replayed signature cannot overwrite the profile with different values.
  if (
    !(await messageBindsMetadata(message, {
      displayName,
      description: description ?? null,
      website: website ?? null,
      category: category ?? null,
      imageUrl: imageUrl ?? null,
    }))
  ) {
    return NextResponse.json(
      { error: 'Signature does not match the submitted profile data' },
      { status: 401 },
    );
  }

  // Logo URL: async SSRF/DNS guard, gated behind auth so an unauthenticated
  // caller can't trigger a server-side DNS resolution of an arbitrary host.
  // 422 = well-formed request, unprocessable field value.
  let safeImageUrl: string | null;
  try {
    safeImageUrl = await validateImageUrl(imageUrl);
  } catch (err) {
    if (err instanceof SsrfError) {
      return NextResponse.json({ error: 'invalid imageUrl', detail: err.message }, { status: 422 });
    }
    throw err;
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
      { signature, message },
      safeImageUrl,
    );
  } catch (err) {
    console.error('[claim:stellar] DB error:', err);
    return NextResponse.json({ error: 'Failed to save claim' }, { status: 500 });
  }

  // On-chain 8004 registration is NOT performed here — see the route docblock.
  // register_with_uri must be signed by the AGENT (caller == owner == agentWallet,
  // contract.rs require_auth). Minting it with AK's validator key would silently
  // fail on execute (agent auth missing; simulate masks it) AND, if it somehow
  // landed, bind agentWallet to AK in violation of spec §3. So we report PENDING
  // honestly rather than fabricate an agentId or a false on-chain success. The
  // agent-signed client-side register lands in the on-chain-write milestone; the
  // off-chain claim below is the user-visible value today.
  const stellarAgentId: number | null = null;
  const onChainRegistration = 'pending' as const;

  // Trigger a regressive scan for the claimer's wallet — fire-and-forget,
  // idempotent (enqueueWalletScan dedups in_progress/cooldown/already_indexed).
  enqueueWalletScan(address, 'stellar').catch((err) => {
    console.error('[claim:stellar] enqueueWalletScan failed:', err);
  });

  return NextResponse.json({
    success: true,
    address,
    displayName,
    claimed: true,
    stellarAgentId,
    onChainRegistration,
  });
}
