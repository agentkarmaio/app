import { NextRequest, NextResponse } from 'next/server';
import { PublicKey } from '@solana/web3.js';
import {
  getWallet,
  upsertAgentManifest,
  insertSignalEvents,
  setWalletTempoAddress,
} from '@/db/client';
import { resolveManifest } from '@/integrations/manifest';
import { buildManifestSignal } from '@/scoring/signals';
import { isTempoAddress } from '@/db/schema';

/**
 * POST /api/agent/manifest/refresh
 *
 * Trigger a manifest re-resolve for a single wallet. Public — hitting this for
 * an arbitrary wallet only causes AgentKarma to re-fetch the wallet's declared
 * website, which is a no-op if the website doesn't serve a manifest. Rate
 * limiting is future work; the fetch cap (5s, 100kb) keeps abuse cheap.
 *
 * Body: { wallet: string }
 */
export async function POST(request: NextRequest) {
  let body: { wallet?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const wallet = body.wallet;
  if (!wallet) {
    return NextResponse.json({ error: 'Missing wallet' }, { status: 400 });
  }
  try { new PublicKey(wallet); } catch {
    return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 });
  }

  const walletRow = await getWallet(wallet);
  if (!walletRow) {
    return NextResponse.json({ error: 'Wallet not found' }, { status: 404 });
  }

  const website = walletRow.website ?? null;
  if (!website) {
    return NextResponse.json({
      wallet,
      resolved: false,
      reason: 'wallet has no declared website',
    });
  }

  const result = await resolveManifest(wallet, website);
  if (!result) {
    return NextResponse.json({
      wallet,
      resolved: false,
      reason: 'no agentkarma.json served at /.well-known/agentkarma.json',
    });
  }

  await upsertAgentManifest({
    agentWallet: wallet,
    sourceType:  result.sourceType,
    url:         result.url,
    raw:         result.raw,
    parsed:      result.parsed,
    verified:    result.verified,
  });

  await insertSignalEvents(
    [buildManifestSignal(wallet, {
      sourceType: result.sourceType,
      verified:   result.verified,
      url:        result.url,
    })],
    { overwrite: true },
  );

  // Mirror a manifest-declared Tempo (MPP) address onto the wallet row so the
  // profile can render it without re-parsing the raw manifest. Declared-only,
  // never blended into Karma.
  const declaredTempo = (result.parsed as { tempoAddress?: string | null }).tempoAddress;
  if (isTempoAddress(declaredTempo)) {
    try { await setWalletTempoAddress(wallet, declaredTempo); }
    catch (err) { console.error('[manifest/refresh] tempo_address update failed:', err); }
  }

  return NextResponse.json({
    wallet,
    resolved: true,
    sourceType: result.sourceType,
    url: result.url,
    verified: result.verified,
    parsed: result.parsed,
  });
}
