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
 */

import { NextResponse } from 'next/server';
import { getSelfVerifier, SELF_SCOPE } from '@/integrations/self';
import { supabase } from '@/db/client';

interface VerifyBody {
  attestationId?: number;
  proof?: unknown;
  publicSignals?: unknown;
  userContextData?: string;
}

export async function POST(req: Request) {
  let body: VerifyBody;
  try {
    body = (await req.json()) as VerifyBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { attestationId, proof, publicSignals, userContextData } = body;
  if (
    attestationId == null ||
    proof == null ||
    publicSignals == null ||
    !userContextData
  ) {
    return NextResponse.json(
      { error: 'missing required fields: attestationId, proof, publicSignals, userContextData' },
      { status: 400 },
    );
  }

  // 1=passport, 2=EU ID, 3=Aadhaar, 4=KYC per @selfxyz/core
  if (attestationId !== 1 && attestationId !== 2 && attestationId !== 3 && attestationId !== 4) {
    return NextResponse.json(
      { error: 'unsupported attestationId; expected 1, 2, 3, or 4' },
      { status: 400 },
    );
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
    return NextResponse.json({ error: 'verification failed', detail: msg }, { status: 400 });
  }

  if (!result.isValidDetails?.isValid) {
    return NextResponse.json(
      { error: 'proof invalid', details: result.isValidDetails },
      { status: 400 },
    );
  }

  // Extract nullifier + the anchored address. userIdentifier is an EVM addr
  // because we configured the verifier with userIdentifierType='hex'.
  const nullifier =
    typeof result.discloseOutput?.nullifier === 'string'
      ? result.discloseOutput.nullifier
      : String(result.discloseOutput?.nullifier ?? '');
  const userIdentifier = String(result.userData?.userIdentifier ?? '').toLowerCase();

  if (!nullifier || !userIdentifier.startsWith('0x')) {
    return NextResponse.json(
      { error: 'verifier returned unexpected shape', result },
      { status: 502 },
    );
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
    return NextResponse.json(
      { error: 'failed to persist attestation', detail: upsertErr.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    chain: 'celo',
    address: userIdentifier,
    scope: SELF_SCOPE,
    verifiedAt: now,
  });
}
