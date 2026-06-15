import { NextRequest, NextResponse } from 'next/server';
import { isRecognizedAddress, detectChain } from '@/lib/chain-detect';
import {
  getWallet,
  getWalletsByAddressAnyChain,
  upsertAgentManifest,
  insertSignalEvents,
  setWalletTempoAddress,
} from '@/db/client';
import { resolveManifest } from '@/integrations/manifest';
import { buildManifestSignal } from '@/scoring/signals';
import { isTempoAddress } from '@/db/schema';
import { declareSuccession } from '@/successions/declare';
import {
  checkRateLimit,
  enforceRateLimit,
  rateLimitHeaders,
} from '@/lib/rate-limit';

/**
 * POST /api/agent/manifest/refresh
 *
 * Trigger a manifest re-resolve for a single wallet. Public — hitting this for
 * an arbitrary wallet causes AgentKarma to make a server-side outbound fetch to
 * the wallet's declared website. That fetch is SSRF-guarded (see
 * @/lib/ssrf + @/integrations/manifest) and rate-limited per IP AND per wallet
 * to bound the outbound-fetch blast radius. The fetch cap (5s, 100kb) keeps
 * abuse cheap on top.
 *
 * Body: { wallet: string }
 */
export async function POST(request: NextRequest) {
  // Per-IP gate first — cheapest rejection, no body read needed.
  const ipGate = await enforceRateLimit('manifest-refresh', request);
  if (!ipGate.ok) return ipGate.response;

  let body: { wallet?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400, headers: ipGate.headers },
    );
  }

  const wallet = body.wallet;
  if (!wallet) {
    return NextResponse.json(
      { error: 'Missing wallet' },
      { status: 400, headers: ipGate.headers },
    );
  }

  // Per-wallet gate: the wallet's declared website is the SSRF target, so one
  // wallet cannot be used to hammer a single internal host past this budget
  // even from rotating IPs.
  const walletLimit = await checkRateLimit('manifest-refresh', `wallet:${wallet}`);
  if (!walletLimit.success) {
    return NextResponse.json(
      { error: 'Rate limit exceeded for this wallet' },
      { status: 429, headers: { ...rateLimitHeaders(walletLimit), ...ipGate.headers } },
    );
  }
  // Chain-dispatched address guard: accept any chain's valid address format
  // (Solana base58, Stellar StrKey G…, EVM 0x… for Celo/Arc). Validity only —
  // EVM chains share a format so the address isn't auto-routable here; this
  // endpoint reads by address, not by chain.
  if (!isRecognizedAddress(wallet)) {
    return NextResponse.json(
      { error: 'Invalid wallet address' },
      { status: 400, headers: ipGate.headers },
    );
  }

  // Chain-aware resolution so celo/arc/stellar wallets resolve (getWallet
  // defaults to solana). detectChain narrows solana/stellar by format; EVM is
  // ambiguous so we pick from the DB rows — never auto-pick an EVM chain. The
  // resolved row's `chain` is what drives the succession declare path below.
  let walletRow = await getWallet(wallet);
  if (!walletRow) {
    const rows = await getWalletsByAddressAnyChain(wallet);
    if (rows.length === 1) {
      walletRow = rows[0];
    } else if (rows.length > 1) {
      const detected = detectChain(wallet);
      walletRow = (detected && rows.find((r) => r.chain === detected)) ?? rows[0];
    }
  }
  if (!walletRow) {
    return NextResponse.json(
      { error: 'Wallet not found' },
      { status: 404, headers: ipGate.headers },
    );
  }

  const website = walletRow.website ?? null;
  if (!website) {
    return NextResponse.json(
      { wallet, resolved: false, reason: 'wallet has no declared website' },
      { headers: ipGate.headers },
    );
  }

  const result = await resolveManifest(wallet, website);
  if (!result) {
    return NextResponse.json(
      {
        wallet,
        resolved: false,
        reason: 'no agentkarma.json served at /.well-known/agentkarma.json',
      },
      { headers: ipGate.headers },
    );
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

  // Self-hosted Dead Man's Switch: if the agentkarma.json declares a `succession`
  // block, run it through the same validated write-path the claim form uses
  // (interval bounds, per-heir address/chain validity, self-as-sole-heir reject).
  // Keyed to the wallet row's own chain — never auto-detected from the address.
  let successionDeclared = false;
  const declaredSuccession = result.parsed.succession;
  if (declaredSuccession) {
    try {
      const decl = await declareSuccession({
        agentWallet: wallet,
        chain: walletRow.chain,
        sourceType: 'self_hosted',
        plan: declaredSuccession,
      });
      successionDeclared = decl.ok;
      if (!decl.ok) {
        console.error('[manifest/refresh] succession rejected:', decl.error);
      }
    } catch (err) {
      console.error('[manifest/refresh] declareSuccession failed:', err);
    }
  }

  return NextResponse.json(
    {
      wallet,
      resolved: true,
      sourceType: result.sourceType,
      url: result.url,
      verified: result.verified,
      parsed: result.parsed,
      successionDeclared,
    },
    { headers: ipGate.headers },
  );
}
