import { NextRequest, NextResponse } from 'next/server';
import {
  getWallet, getWalletsByAddressAnyChain, getTransactions, getFeedbackSummary,
  getLatestSignalValues, getSignalEventsForWallet,
  getSuccession, getBondsForAgent, getUnderwriterPositions,
} from '@/db/client';
import { detectChain } from '@/lib/chain-detect';
import type { SignalEvent } from '@/db/schema';
import { calculateScore } from '@/scoring/index';
import { computeCadence } from '@/scoring/cadence';
import { computeAutonomy } from '@/scoring/autonomy';
import { computeSurety } from '@/scoring/surety';
import { deriveSuccessionLiveness } from '@/scoring/succession';
import { readAttestation } from '@/integrations/attestation';
import { corsHeaders, corsPreflight } from '@/lib/rate-limit';
import type { Chain } from '@/db/schema';
import {
  buildSuccessionView, buildBondView, buildSuretyView, isBondSettled, toSuretyPosition,
} from '@/lib/succession-view';

export async function OPTIONS() {
  return corsPreflight();
}

type Face = 'provider' | 'consumer' | 'both';

/**
 * GET /api/v2/score/{wallet}?face=provider|consumer|both
 *
 * Two-faced karma — Phase I. A wallet may be strong on one face and weak on
 * the other. Marketplace callers indicate which face they need via `?face`.
 * Default: both.
 *
 *   provider — "If I pay this agent, will it deliver?"
 *              Primarily Tier 1 attestations + Tier 3 declared identity.
 *
 *   consumer — "If I take work from this agent, will it pay me cleanly?"
 *              Primarily Tier 2 payment behavior (success, volume, cadence).
 *
 * Response shape is stable under added keys. Face blocks are omitted when
 * they don't apply or when the caller selected a single face.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ wallet: string }> },
) {
  const { wallet } = await params;
  const faceParam = (new URL(request.url).searchParams.get('face') ?? 'both').toLowerCase();
  const face: Face = faceParam === 'provider' || faceParam === 'consumer' ? faceParam : 'both';

  if (!wallet || wallet.length < 32) {
    return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 });
  }

  // Chain-aware resolution. getWallet defaults to solana, so a celo/arc/stellar
  // wallet would miss. When the solana lookup misses, fall back to ANY-chain
  // resolution: detectChain narrows solana/stellar by format; EVM addresses are
  // ambiguous (celo vs arc) and detectChain returns null, so we pick the real
  // row from getWalletsByAddressAnyChain. We NEVER auto-pick an EVM chain — we
  // read whichever row(s) the DB holds and prefer the format-detected chain.
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

  const transactions = await getTransactions(wallet, 1000);

  if (!walletRow && transactions.length === 0) {
    return NextResponse.json({ error: 'Wallet not found' }, { status: 404 });
  }

  let feedback = { deliveryRate: 0, total: 0 };
  try { feedback = await getFeedbackSummary(wallet); } catch { /* ok */ }

  const [attestation, manifestMap, signalEvents] = await Promise.all([
    readAttestation(wallet).catch(() => 0),
    getLatestSignalValues([wallet], 'manifest').catch(() => new Map<string, number>()),
    getSignalEventsForWallet(wallet, 200).catch(() => [] as SignalEvent[]),
  ]);

  const cadence = transactions.length > 0
    ? computeCadence(transactions.map((tx) => new Date(tx.timestamp)))
    : null;

  const autonomy = transactions.length > 0
    ? computeAutonomy(
        transactions.map((tx) => ({ timestamp: tx.timestamp, counterparty: tx.facilitator })),
      )
    : null;

  const live = transactions.length > 0
    ? calculateScore(
        transactions,
        attestation,
        feedback.deliveryRate,
        feedback.total,
        cadence?.automationScore ?? null,
        manifestMap.get(wallet) ?? null,
        null,
        signalEvents,
      )
    : null;

  const identity = walletRow?.claimed ? {
    displayName: walletRow.display_name ?? null,
    description: walletRow.description ?? null,
    website: walletRow.website ?? null,
    category: walletRow.category ?? null,
    claimed: true,
  } : { claimed: false };

  const response: Record<string, unknown> = {
    address: wallet,
    face,
    identity,
    txCount: live?.txCount ?? walletRow?.tx_count ?? 0,
    lastActive: live?.lastActive ?? walletRow?.last_seen ?? null,
  };

  if (face === 'provider' || face === 'both') {
    response.provider = live ? {
      score: live.providerScore,
      trustTier: live.trustTier,
      confidenceBadge: live.confidenceBadge,
      metrics: live.metrics,
      tierAggregates: live.tierAggregates,
      hasSignal: hasProviderSignal(live.tierAggregates),
    } : {
      score: walletRow?.provider_score != null ? Number(walletRow.provider_score) : 0,
      trustTier: walletRow?.trust_tier ?? 'Unrated',
      confidenceBadge: walletRow?.confidence_badge ?? 'declared',
      metrics: null,
      tierAggregates: null,
      hasSignal: false,
    };
  }

  // Autonomy Confidence (RFC v0.3 §5.5) — MUST appear alongside karma on every
  // response, independent of which face was requested.
  response.autonomy = autonomy ? {
    score: autonomy.score,
    label: autonomy.label,
    signals: autonomy.components,
    effectiveWeights: autonomy.effectiveWeights,
    txCount: autonomy.txCount,
    lastUpdated: new Date().toISOString(),
  } : {
    score: walletRow?.autonomy_score != null ? Number(walletRow.autonomy_score) : null,
    label: walletRow?.autonomy_label ?? null,
    signals: null,
    effectiveWeights: null,
    txCount: 0,
    lastUpdated: walletRow?.updated_at ?? null,
  };

  if (face === 'consumer' || face === 'both') {
    response.consumer = live?.consumerFace ? {
      score: live.consumerFace.score,
      trustTier: live.consumerFace.trustTier,
      confidenceBadge: live.consumerFace.confidenceBadge,
      metrics: live.consumerFace.metrics,
      tierAggregates: live.consumerFace.tierAggregates,
      hasSignal: true,
    } : {
      score: walletRow?.consumer_score != null ? Number(walletRow.consumer_score) : null,
      trustTier: null,
      confidenceBadge: null,
      metrics: null,
      tierAggregates: null,
      hasSignal: false,
    };
  }

  // --- Additive blocks: succession / bond / surety (Bonding + Dead Man's
  // Switch). PURELY ADDITIVE — existing consumers ignore unknown keys, so these
  // never break the stable score shape. AK is OBSERVE-ONLY: these read public
  // lifecycle projections + pure derivations, never custody or execution.
  //
  // CEILING DISCIPLINE: these blocks are descriptive only. A bond/will lifts the
  // confidence badge + Tier-presence in the SCORING layer, never the trust
  // ceiling here — this route surfaces state, it does not re-grade.
  const blockChain: Chain = walletRow?.chain ?? 'solana';
  await Promise.all([
    attachSuccessionBlock(response, wallet, blockChain, transactions[0]?.timestamp ?? null),
    attachBondBlocks(response, wallet, blockChain),
  ]);

  return NextResponse.json(response, {
    headers: {
      ...corsHeaders(),
      'Cache-Control': 'public, max-age=60',
    },
  });
}

/**
 * Attach the `succession` block when the agent has a declared will. Best-effort:
 * a DB hiccup here must never sink the core score response.
 */
async function attachSuccessionBlock(
  response: Record<string, unknown>,
  wallet: string,
  chain: Chain,
  lastTxAt: string | null,
): Promise<void> {
  try {
    const succession = await getSuccession(wallet, chain);
    if (!succession) return;
    const liveness = deriveSuccessionLiveness({
      succession: { status: succession.status, interval_seconds: succession.interval_seconds },
      lastMeaningfulTxAt: lastTxAt ?? succession.last_heartbeat_at,
    });
    response.succession = buildSuccessionView(succession, liveness);
  } catch { /* additive — omit on failure */ }
}

/**
 * Attach the `bond` block (bonds on this agent; demo rows flagged) and the
 * orthogonal `surety` block (this wallet's underwriting quality). Best-effort.
 */
async function attachBondBlocks(
  response: Record<string, unknown>,
  wallet: string,
  chain: Chain,
): Promise<void> {
  try {
    const [bonds, positions] = await Promise.all([
      getBondsForAgent(wallet, chain),
      getUnderwriterPositions(wallet, chain),
    ]);

    if (bonds.length > 0) {
      const views = bonds.map(buildBondView);
      response.bond = {
        open: views.filter((b) => !isBondSettled(b.status) && b.status !== 'expired'),
        resolved: views.filter((b) => isBondSettled(b.status) || b.status === 'expired'),
        totalBondedUsdc: Math.round(
          views.reduce((s, b) => s + (b.currency === 'USDC' ? b.amount : 0), 0) * 1e6,
        ) / 1e6,
        hasDemo: views.some((b) => b.isDemo),
      };
    }

    // Surety is ORTHOGONAL — its own top-level block, never merged into provider/
    // consumer karma. Omitted when the wallet underwrites nothing.
    const surety = computeSurety(positions.map(toSuretyPosition));
    if (surety) response.surety = buildSuretyView(surety);
  } catch { /* additive — omit on failure */ }
}

/**
 * A provider face has real signal when Tier 1 or Tier 3 is present. Tier 2
 * alone is ambiguous — could be consumer behavior mislabelled as provider.
 * Phase G1b (recipient extraction) will tighten this.
 */
function hasProviderSignal(t: { tier1?: number | null; tier3?: number | null }): boolean {
  return (t.tier1 != null && t.tier1 >= 0) || (t.tier3 != null && t.tier3 >= 0);
}
