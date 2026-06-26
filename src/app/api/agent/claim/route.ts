import { NextRequest, NextResponse } from 'next/server';
import { PublicKey } from '@solana/web3.js';
import { claimWallet, enqueueWalletScan } from '@/db/client';
import { verifySolanaClaimSignature } from '@/lib/claim-verify';
import { validateAgentMetadata, validateImageUrl } from '@/lib/agent-metadata';
import { messageBindsMetadata } from '@/lib/claim-challenge';
import { SsrfError } from '@/lib/ssrf-guard';
import { declareSuccession } from '@/successions/declare';

export const runtime = 'nodejs'; // validateImageUrl → SSRF guard needs node:dns/net

/**
 * POST /api/agent/claim
 *
 * Claim a wallet to enrich its agent profile with identity metadata.
 * Requires a Solana wallet signature to prove ownership.
 *
 * Body:
 *   address:      string — wallet address
 *   displayName:  string — agent display name (required, 1-50 chars)
 *   description:  string — short description (optional, max 280 chars)
 *   website:      string — URL (optional)
 *   category:     string — one of VALID_CATEGORIES (optional)
 *   tempoAddress: string — Tempo (MPP) EVM 0x… 42-char address (optional, Tier 3 declared-only)
 *   signature:    string — base58-encoded Ed25519 signature
 *   message:      string — the signed message (must match expected format)
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { address, displayName, description, website, category, tempoAddress, imageUrl, succession, signature, message } = body as {
    address?: string;
    displayName?: string;
    description?: string;
    website?: string;
    category?: string;
    tempoAddress?: string | null;
    imageUrl?: string | null;
    /** Optional Dead Man's Switch plan: { intervalSeconds, heirs[] }. Solana-keyed. */
    succession?: unknown;
    signature?: string;
    message?: string;
  };

  // Validate required fields
  if (!address || !displayName || !signature || !message) {
    return NextResponse.json(
      { error: 'Missing required fields: address, displayName, signature, message' },
      { status: 400 },
    );
  }

  // Validate address format
  try {
    new PublicKey(address);
  } catch {
    return NextResponse.json({ error: 'Invalid Solana wallet address' }, { status: 400 });
  }

  // Shared field validation (sync). Tempo is a Solana-only declared signal.
  const metaCheck = validateAgentMetadata(
    { displayName, description, website, category, tempoAddress },
    { allowTempo: true },
  );
  if (!metaCheck.ok) {
    return NextResponse.json({ error: metaCheck.error }, { status: 400 });
  }

  // Validate message format: "AgentKarma: Claim wallet {address} at {timestamp}"
  const messagePrefix = `AgentKarma: Claim wallet ${address} at `;
  if (!message.startsWith(messagePrefix)) {
    return NextResponse.json({ error: 'Invalid message format' }, { status: 400 });
  }

  // Check timestamp is recent (within 5 minutes). parseInt (not Number) so the
  // trailing " | sha256:…" metadata binding doesn't poison the parse.
  const messageTs = parseInt(message.slice(messagePrefix.length), 10);
  if (isNaN(messageTs) || Math.abs(Date.now() - messageTs) > 5 * 60 * 1000) {
    return NextResponse.json({ error: 'Message timestamp expired (5 minute window)' }, { status: 400 });
  }

  // Verify Ed25519 signature (canonical verifier — shared with the prove route).
  if (!verifySolanaClaimSignature(address, message, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Metadata binding: the signed message must commit to EXACTLY these fields, so
  // a replayed signature cannot overwrite the profile with different values — or
  // smuggle an attacker-chosen succession plan past the identity binding.
  if (
    !(await messageBindsMetadata(message, {
      displayName,
      description: description ?? null,
      website: website ?? null,
      category: category ?? null,
      imageUrl: imageUrl ?? null,
      tempoAddress: tempoAddress ?? null,
      succession,
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

  // Pre-validate the optional succession plan BEFORE any DB write, so a bad plan
  // is a clean 400 rather than a claim-then-fail half-state. Solana-keyed (this
  // route authenticates a Solana signature).
  if (succession !== undefined && succession !== null) {
    const { validateSuccessionPlan } = await import('@/successions/validate');
    const v = validateSuccessionPlan(succession, 'solana', address);
    if (!v.ok) {
      return NextResponse.json({ error: `Invalid succession plan: ${v.error}` }, { status: 400 });
    }
  }

  // Write to DB
  try {
    await claimWallet(
      address,
      displayName,
      description ?? null,
      website ?? null,
      category ?? null,
      tempoAddress ?? null,
      'solana',
      { signature, message },
      safeImageUrl,
    );
  } catch (err) {
    console.error('[claim] DB error:', err);
    return NextResponse.json({ error: 'Failed to save claim' }, { status: 500 });
  }

  // Persist the optional succession plan now the wallet row exists (FK target).
  // Already validated above; declareSuccession upserts the will + emits the
  // Tier-3 will_declared signal (which NEVER lifts the badge off ⚪ alone).
  let successionDeclared = false;
  if (succession !== undefined && succession !== null) {
    try {
      const result = await declareSuccession({
        agentWallet: address,
        chain: 'solana',
        sourceType: 'claim_form',
        plan: succession,
      });
      successionDeclared = result.ok;
      if (!result.ok) {
        console.error('[claim] declareSuccession rejected post-claim:', result.error);
      }
    } catch (err) {
      // Non-fatal: the claim itself succeeded. Surface in logs; the heartbeat
      // worker / a re-declare can reconcile later.
      console.error('[claim] declareSuccession failed:', err);
    }
  }

  // Trigger regressive scan for the claimer's wallet — historical activity
  // not yet indexed because no facilitator-side scan has touched it.
  // Idempotent: enqueueWalletScan handles dedup (in_progress, cooldown, already_indexed).
  // Fire-and-forget: claim should return promptly; scan is bonus, not critical.
  enqueueWalletScan(address).catch((err) => {
    console.error('[claim] enqueueWalletScan failed:', err);
  });

  return NextResponse.json({
    success: true,
    address,
    displayName,
    claimed: true,
    successionDeclared,
  });
}
