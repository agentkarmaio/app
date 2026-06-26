import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { claimWallet } from '@/db/client';
import type { Chain } from '@/db/schema';
import { verifyEvmClaimSignature } from '@/lib/claim-verify';
import { validateAgentMetadata, validateImageUrl } from '@/lib/agent-metadata';
import { messageBindsMetadata } from '@/lib/claim-challenge';
import { SsrfError } from '@/lib/ssrf-guard';

export const runtime = 'nodejs'; // validateImageUrl → SSRF guard needs node:dns/net

const VALID_CHAINS: ReadonlyArray<Extract<Chain, 'celo' | 'arc'>> = ['celo', 'arc'];
const CLAIM_WINDOW_MS = 5 * 60 * 1000;

/**
 * POST /api/agent/claim/evm
 *
 * Claim a Celo / Arc (0x…) wallet to enrich its agent profile. Proves ownership
 * via an EIP-191 personal_sign over the canonical challenge (byte-identical to
 * the Solana / Stellar routes). One route serves both EVM chains; the `chain`
 * field selects the (chain, address) composite-PK row.
 *
 * EVM rows are keyed LOWERCASE (the indexer stores owner.toLowerCase()), so the
 * address is lowercased before any DB touch. Signature recovery is checksum-
 * insensitive (getAddress on both sides), so any wallet casing verifies.
 *
 * On-chain 8004 registration is NOT performed here — register must be signed by
 * the agent itself, not AK's validator key. The claim succeeds OFF-CHAIN and
 * enriches the declared-tier profile; the badge stays ⚪ declared.
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { address, chain, displayName, description, website, category, imageUrl, signature, message } = body as {
    address?: string;
    chain?: string;
    displayName?: string;
    description?: string;
    website?: string;
    category?: string;
    imageUrl?: string | null;
    signature?: string;
    message?: string;
  };

  if (!address || !chain || !displayName || !signature || !message) {
    return NextResponse.json(
      { error: 'Missing required fields: address, chain, displayName, signature, message' },
      { status: 400 },
    );
  }

  if (!VALID_CHAINS.includes(chain as Extract<Chain, 'celo' | 'arc'>)) {
    return NextResponse.json({ error: `chain must be one of: ${VALID_CHAINS.join(', ')}` }, { status: 400 });
  }
  if (!isAddress(address)) {
    return NextResponse.json({ error: 'Invalid EVM wallet address' }, { status: 400 });
  }

  // Shared field validation (sync). No tempo on EVM claims.
  const metaCheck = validateAgentMetadata({ displayName, description, website, category });
  if (!metaCheck.ok) {
    return NextResponse.json({ error: metaCheck.error }, { status: 400 });
  }

  // Challenge format: "AgentKarma: Claim wallet {0x…} at {ts}" — identical to
  // the other chains, with the claimed address embedded verbatim.
  const messagePrefix = `AgentKarma: Claim wallet ${address} at `;
  if (!message.startsWith(messagePrefix)) {
    return NextResponse.json({ error: 'Invalid message format' }, { status: 400 });
  }
  // parseInt (not Number) so the trailing " | sha256:…" binding doesn't poison it.
  const messageTs = parseInt(message.slice(messagePrefix.length), 10);
  if (Number.isNaN(messageTs) || Math.abs(Date.now() - messageTs) > CLAIM_WINDOW_MS) {
    return NextResponse.json({ error: 'Message timestamp expired (5 minute window)' }, { status: 400 });
  }

  // The signature gate — canonical verifier (shared with the prove route).
  // Checksum-insensitive recover-and-compare; false on any malformed input.
  if (!(await verifyEvmClaimSignature(address, message, signature))) {
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

  // Persist the claim against the lowercase (chain, address) row.
  try {
    await claimWallet(
      address.toLowerCase(),
      displayName,
      description ?? null,
      website ?? null,
      category ?? null,
      null,
      chain as Chain,
      { signature, message },
      safeImageUrl,
    );
  } catch (err) {
    console.error('[claim:evm] DB error:', err);
    return NextResponse.json({ error: 'Failed to save claim' }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    address: address.toLowerCase(),
    chain,
    displayName,
    claimed: true,
    onChainRegistration: 'pending',
  });
}
