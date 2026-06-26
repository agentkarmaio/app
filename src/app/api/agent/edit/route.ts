import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { PublicKey } from '@solana/web3.js';
import { isChain, type Chain } from '@/db/schema';
import { updateClaimedAgentMetadata } from '@/db/client';
import { buildEditChallenge, verifyClaimSignature } from '@/lib/claim-verify';
import { isStellarAddress } from '@/lib/stellar-verify';
import { validateAgentMetadata, validateImageUrl } from '@/lib/agent-metadata';
import { SsrfError } from '@/lib/ssrf-guard';

export const runtime = 'nodejs'; // validateImageUrl → SSRF guard needs node:dns/net

const CLAIM_WINDOW_MS = 5 * 60 * 1000;

/**
 * POST /api/agent/edit
 *
 * Update an ALREADY-CLAIMED agent's identity metadata (display name,
 * description, website, category, logo, and — Solana only — Tempo address).
 * Chain-unified: one route serves solana/celo/arc/stellar, authed by the SAME
 * byte-identical claim challenge the /api/agent/prove route uses. Only the
 * keyholder of the agent's wallet can produce the signature, so this gates edits
 * to the owner. Unlike the claim routes it has NO succession/scan side-effects.
 *
 * Full-replace semantics: the edit form is pre-filled with current values, so a
 * blank field clears it. `validateImageUrl` maps empty → null (never '').
 *
 * Body: { address, chain, displayName, description?, website?, category?,
 *         imageUrl?, tempoAddress? (solana-only), signature, message }
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { address, chain, displayName, description, website, category, imageUrl, tempoAddress, signature, message } =
    body as {
      address?: string;
      chain?: string;
      displayName?: string;
      description?: string | null;
      website?: string | null;
      category?: string | null;
      imageUrl?: string | null;
      tempoAddress?: string | null;
      signature?: string;
      message?: string;
    };

  if (!address || !chain || !displayName || !signature || !message) {
    return NextResponse.json(
      { error: 'Missing required fields: address, chain, displayName, signature, message' },
      { status: 400 },
    );
  }
  if (!isChain(chain)) {
    return NextResponse.json({ error: 'Invalid chain' }, { status: 400 });
  }

  // Per-chain address validation + normalization (EVM rows are lowercase) —
  // identical to /api/agent/prove so the challenge address matches the stored row.
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

  // Cheap field validation (sync). Tempo is Solana-only declared signal.
  const isSolana = chain === 'solana';
  const v = validateAgentMetadata(
    { displayName, description, website, category, tempoAddress },
    { allowTempo: isSolana },
  );
  if (!v.ok) {
    return NextResponse.json({ error: v.error }, { status: 400 });
  }

  // Operation-scoped challenge: edits sign "Edit wallet …", NOT the "Claim
  // wallet …" challenge. A publicly-displayed claim/prove receipt therefore can
  // never be replayed here, and the edit signature is never persisted (below),
  // so there's no public sink to replay back. Fresh-timestamp embedded.
  const prefix = buildEditChallenge(normalized, '');
  if (!message.startsWith(prefix)) {
    return NextResponse.json({ error: 'Invalid message format' }, { status: 400 });
  }
  const ts = Number(message.slice(prefix.length));
  if (Number.isNaN(ts) || Math.abs(Date.now() - ts) > CLAIM_WINDOW_MS) {
    return NextResponse.json({ error: 'Message timestamp expired (5 minute window)' }, { status: 400 });
  }

  // The signature gate — only the keyholder can edit. MUST run before the async
  // logo guard so an unauthenticated caller can't trigger a server-side DNS
  // resolution of an arbitrary host via the SSRF check below.
  if (!(await verifyClaimSignature(chain as Chain, normalized, message, signature))) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Logo URL: async SSRF/DNS guard, gated behind auth. 422 = well-formed
  // request, unprocessable field value.
  let safeImageUrl: string | null;
  try {
    safeImageUrl = await validateImageUrl(imageUrl);
  } catch (err) {
    if (err instanceof SsrfError) {
      return NextResponse.json({ error: 'invalid imageUrl', detail: err.message }, { status: 422 });
    }
    throw err;
  }

  let result: Awaited<ReturnType<typeof updateClaimedAgentMetadata>>;
  try {
    result = await updateClaimedAgentMetadata(
      normalized,
      chain as Chain,
      {
        displayName,
        description: description ?? null,
        website: website ?? null,
        category: category ?? null,
        imageUrl: safeImageUrl,
        // Solana: full-replace (null clears). Other chains: omit → untouched.
        ...(isSolana ? { tempoAddress: tempoAddress ?? null } : {}),
      },
    );
  } catch (err) {
    console.error('[edit] DB error:', err);
    return NextResponse.json({ error: 'Failed to save changes' }, { status: 500 });
  }

  if (!result.ok) {
    return result.reason === 'not_claimed'
      ? NextResponse.json({ error: 'Agent is not claimed — claim it first' }, { status: 409 })
      : NextResponse.json({ error: 'No claimed agent found for this address' }, { status: 404 });
  }

  return NextResponse.json({ success: true, address: normalized, chain, updated: true });
}
