import { NextRequest, NextResponse } from 'next/server';
import { getWallet, getTransactions, getLatestSignalValues } from '@/db/client';
import { calculateScore } from '@/scoring/index';
import { computeCadence } from '@/scoring/cadence';
import { computeAutonomy } from '@/scoring/autonomy';
import { corsHeaders, corsPreflight, enforceRateLimit } from '@/lib/rate-limit';

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ wallet: string }> }
) {
  const gate = await enforceRateLimit('score', request);
  if (!gate.ok) return gate.response;

  const { wallet } = await params;

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

  const identity = walletRow?.claimed ? {
    displayName: walletRow.display_name ?? null,
    description: walletRow.description ?? null,
    website: walletRow.website ?? null,
    category: walletRow.category ?? null,
    claimed: true,
  } : { claimed: false };

  const entity = walletRow ? {
    name: walletRow.entity_name ?? null,
    category: walletRow.entity_category ?? null,
  } : null;

  const fundedBy = walletRow?.funded_by ? {
    address: walletRow.funded_by,
    name: walletRow.funded_by_name ?? null,
  } : null;

  const providerScore = walletRow?.provider_score != null
    ? Number(walletRow.provider_score)
    : Number(walletRow?.score ?? 0);
  const consumerScore = walletRow?.consumer_score != null
    ? Number(walletRow.consumer_score)
    : null;
  const confidenceBadge = walletRow?.confidence_badge ?? 'declared';

  const storedAutonomy = walletRow?.autonomy_score != null ? {
    score: Number(walletRow.autonomy_score),
    label: walletRow.autonomy_label ?? null,
  } : null;

  if (transactions.length === 0) {
    return NextResponse.json({
      address: wallet,
      score: walletRow?.score ?? 0,
      providerScore,
      consumerScore,
      confidenceBadge,
      autonomy: storedAutonomy,
      trustTier: walletRow?.trust_tier ?? 'Unrated',
      metrics: { successRate: 0, diversity: 0, volume: 0, age: 0 },
      txCount: 0,
      lastActive: walletRow?.last_seen ?? null,
      identity,
      entity,
      fundedBy,
      sybilRisk: walletRow?.sybil_risk ?? false,
    }, {
      headers: {
        ...gate.headers,
        ...corsHeaders(),
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120',
      },
    });
  }

  const cadence = computeCadence(transactions.map((tx) => new Date(tx.timestamp)));
  const autonomy = computeAutonomy(
    transactions.map((tx) => ({ timestamp: tx.timestamp, counterparty: tx.facilitator })),
  );
  const manifestMap = await getLatestSignalValues([wallet], 'manifest').catch(() => new Map<string, number>());
  const score = calculateScore(
    transactions,
    0,
    undefined,
    undefined,
    cadence?.automationScore ?? null,
    manifestMap.get(wallet) ?? null,
  );
  return NextResponse.json({
    ...score,
    providerScore: score.providerScore,
    consumerScore: score.consumerScore,
    confidenceBadge: score.confidenceBadge,
    autonomy: autonomy ? {
      score: autonomy.score,
      label: autonomy.label,
      components: autonomy.components,
    } : storedAutonomy,
    identity,
    entity,
    fundedBy,
    sybilRisk: walletRow?.sybil_risk ?? false,
  }, {
    headers: {
      ...gate.headers,
      ...corsHeaders(),
      'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120',
    },
  });
}
