import { NextRequest, NextResponse } from 'next/server';
import { getWallet, getTransactions } from '@/db/client';
import { calculateScore } from '@/scoring/index';
import { computeCadence } from '@/scoring/cadence';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ wallet: string }> }
) {
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

  if (transactions.length === 0) {
    return NextResponse.json({
      address: wallet,
      score: walletRow?.score ?? 0,
      providerScore,
      consumerScore,
      confidenceBadge,
      trustTier: walletRow?.trust_tier ?? 'Unrated',
      metrics: { successRate: 0, diversity: 0, volume: 0, age: 0 },
      txCount: 0,
      lastActive: walletRow?.last_seen ?? null,
      identity,
      entity,
      fundedBy,
      sybilRisk: walletRow?.sybil_risk ?? false,
    });
  }

  const cadence = computeCadence(transactions.map((tx) => new Date(tx.timestamp)));
  const score = calculateScore(
    transactions,
    0,
    undefined,
    undefined,
    cadence?.automationScore ?? null,
  );
  return NextResponse.json({
    ...score,
    providerScore: score.providerScore,
    consumerScore: score.consumerScore,
    confidenceBadge: score.confidenceBadge,
    identity,
    entity,
    fundedBy,
    sybilRisk: walletRow?.sybil_risk ?? false,
  });
}
