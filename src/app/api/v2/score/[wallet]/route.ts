import { NextRequest, NextResponse } from 'next/server';
import {
  getWallet, getTransactions, getFeedbackSummary, getLatestSignalValues,
} from '@/db/client';
import { calculateScore } from '@/scoring/index';
import { computeCadence } from '@/scoring/cadence';
import { readAttestation } from '@/integrations/attestation';

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

  const [walletRow, transactions] = await Promise.all([
    getWallet(wallet),
    getTransactions(wallet, 1000),
  ]);

  if (!walletRow && transactions.length === 0) {
    return NextResponse.json({ error: 'Wallet not found' }, { status: 404 });
  }

  let feedback = { deliveryRate: 0, total: 0 };
  try { feedback = await getFeedbackSummary(wallet); } catch { /* ok */ }

  const [attestation, manifestMap] = await Promise.all([
    readAttestation(wallet).catch(() => 0),
    getLatestSignalValues([wallet], 'manifest').catch(() => new Map<string, number>()),
  ]);

  const cadence = transactions.length > 0
    ? computeCadence(transactions.map((tx) => new Date(tx.timestamp)))
    : null;

  const live = transactions.length > 0
    ? calculateScore(
        transactions,
        attestation,
        feedback.deliveryRate,
        feedback.total,
        cadence?.automationScore ?? null,
        manifestMap.get(wallet) ?? null,
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

  return NextResponse.json(response, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=60',
    },
  });
}

/**
 * A provider face has real signal when Tier 1 or Tier 3 is present. Tier 2
 * alone is ambiguous — could be consumer behavior mislabelled as provider.
 * Phase G1b (recipient extraction) will tighten this.
 */
function hasProviderSignal(t: { tier1?: number | null; tier3?: number | null }): boolean {
  return (t.tier1 != null && t.tier1 >= 0) || (t.tier3 != null && t.tier3 >= 0);
}
