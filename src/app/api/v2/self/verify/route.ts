/**
 * POST /api/v2/self/verify
 *
 * Receives a Self Protocol ZK proof, verifies it via @selfxyz/core, and
 * records the (nullifier, scope, verified-at) tuple on the wallet row.
 *
 * Storage scope: chain='celo' by default — Self lives on Celo. Cross-chain
 * Self attestation portability is a follow-up; today the attestation is
 * scoped to the wallet that signed the user-context.
 *
 * Body shape (per @selfxyz/core conventions):
 *   {
 *     attestationId: number,
 *     proof: object,
 *     publicSignals: string[],
 *     userContextData: hex string  // contains the EVM address being anchored
 *   }
 *
 * Response contract (Self spec — STRICT):
 *  - ALWAYS HTTP 200, regardless of outcome.
 *  - Success: { status: 'success', result: true, credentialSubject: {…} }
 *  - Failure: { status: 'error', result: false, reason, error_code, details? }
 *  - The mobile app errors with "missing field `status`" if either field is
 *    absent. Don't change this shape without re-reading docs.self.xyz.
 */

import { NextResponse } from 'next/server';
import { getSelfVerifier, SELF_SCOPE } from '@/integrations/self';
import { supabase } from '@/db/client';

// Pin to Node — @selfxyz/core constructs a JsonRpcProvider on first call and
// can't run in Edge.
export const runtime = 'nodejs';

interface VerifyBody {
  attestationId?: number;
  proof?: unknown;
  publicSignals?: unknown;
  userContextData?: string;
}

function selfError(reason: string, errorCode: string, details?: unknown) {
  return NextResponse.json(
    {
      status: 'error',
      result: false,
      reason,
      error_code: errorCode,
      ...(details !== undefined ? { details } : {}),
    },
    { status: 200 }, // Self spec: ALWAYS 200, regardless of outcome.
  );
}

export async function POST(req: Request) {
  let body: VerifyBody;
  try {
    body = (await req.json()) as VerifyBody;
  } catch {
    return selfError('invalid JSON body', 'BAD_REQUEST');
  }

  const { attestationId, proof, publicSignals, userContextData } = body;
  if (
    attestationId == null ||
    proof == null ||
    publicSignals == null ||
    !userContextData
  ) {
    return selfError(
      'missing required fields: attestationId, proof, publicSignals, userContextData',
      'BAD_REQUEST',
    );
  }

  // 1=passport, 2=EU ID, 3=Aadhaar, 4=KYC per @selfxyz/core
  if (attestationId !== 1 && attestationId !== 2 && attestationId !== 3 && attestationId !== 4) {
    return selfError('unsupported attestationId; expected 1, 2, 3, or 4', 'BAD_REQUEST');
  }

  let result: Awaited<ReturnType<ReturnType<typeof getSelfVerifier>['verify']>>;
  try {
    const verifier = getSelfVerifier();
    result = await verifier.verify(
      attestationId,
      proof as never,
      publicSignals as never,
      userContextData,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return selfError(msg, 'VERIFICATION_FAILED');
  }

  if (!result.isValidDetails?.isValid) {
    return selfError('proof invalid', 'VERIFICATION_FAILED', result.isValidDetails);
  }

  // Extract nullifier + the anchored address. userIdentifier is an EVM addr
  // because we configured the verifier with userIdentifierType='hex'.
  const nullifier =
    typeof result.discloseOutput?.nullifier === 'string'
      ? result.discloseOutput.nullifier
      : String(result.discloseOutput?.nullifier ?? '');
  const userIdentifier = String(result.userData?.userIdentifier ?? '').toLowerCase();

  if (!nullifier || !userIdentifier.startsWith('0x')) {
    return selfError('verifier returned unexpected shape', 'INTERNAL_ERROR');
  }

  // Anchor on the Celo wallet row. The composite PK is (chain, address) so
  // we upsert against ('celo', userIdentifier). If the wallet row doesn't
  // exist yet, create a stub.
  const now = new Date().toISOString();
  const { error: upsertErr } = await supabase
    .from('wallets')
    .upsert(
      {
        chain: 'celo',
        address: userIdentifier,
        self_nullifier: nullifier,
        self_verified_at: now,
        self_scope: SELF_SCOPE,
        updated_at: now,
      },
      { onConflict: 'chain,address' },
    );
  if (upsertErr) {
    // 23505 = unique_violation. Our self_nullifier UNIQUE constraint fires
    // when this passport already anchored a different wallet. Surface as a
    // distinct error_code so callers can distinguish replay/sybil from real
    // persistence failures.
    if ((upsertErr as { code?: string }).code === '23505') {
      return selfError(
        'one passport per scope can anchor at most one wallet — first wallet wins',
        'NULLIFIER_ALREADY_ANCHORED',
      );
    }
    return selfError(`failed to persist attestation: ${upsertErr.message}`, 'INTERNAL_ERROR');
  }

  return NextResponse.json(
    {
      status: 'success',
      result: true,
      credentialSubject: {
        nullifier,
        userIdentifier,
        chain: 'celo',
        scope: SELF_SCOPE,
        verifiedAt: now,
      },
    },
    { status: 200 },
  );
}
