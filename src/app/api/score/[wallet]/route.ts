import { NextRequest, NextResponse } from 'next/server';
import { PublicKey } from '@solana/web3.js';
import { getWallet, getTransactions, getLatestSignalValues, enqueueWalletScan } from '@/db/client';
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
  const { wallet } = await params;

  // Validate wallet format BEFORE rate limiting — invalid input shouldn't
  // consume rate budget. PublicKey constructor throws on bad base58 / wrong
  // byte length, covering the previous `length < 32` heuristic.
  if (!wallet) {
    return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 });
  }
  try {
    new PublicKey(wallet);
  } catch {
    return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 });
  }

  const gate = await enforceRateLimit('score', request);
  if (!gate.ok) return gate.response;

  const [walletRow, transactions] = await Promise.all([
    getWallet(wallet),
    getTransactions(wallet, 1000),
  ]);

  if (!walletRow && transactions.length === 0) {
    // Unknown wallet: enqueue a regressive scan and return 202 Accepted so
    // the client can poll. Use the dedicated `wallet-scan-enqueue` bucket
    // (3/min/IP) — cheaper than the score budget and prevents scan-flooding
    // from arbitrary 404 traffic. The 202 response uses the scan-enqueue
    // gate's headers (it's the gate that authorized this code path).
    const scanGate = await enforceRateLimit('wallet-scan-enqueue', request);
    if (!scanGate.ok) return scanGate.response;

    const result = await enqueueWalletScan(wallet);

    return NextResponse.json(
      {
        address: wallet,
        scanning: true,
        enqueued: result.enqueued,
        reason: result.reason ?? null,
      },
      {
        status: 202,
        headers: {
          ...scanGate.headers,
          ...corsHeaders(),
          'Cache-Control': 'no-store',
        },
      },
    );
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
    // Scan in flight against this stub? Surface 202 so the client poller
    // keeps polling instead of treating the empty payload as "done".
    const scanInFlight =
      walletRow?.scan_state === 'pending' || walletRow?.scan_state === 'scanning';
    if (scanInFlight) {
      return NextResponse.json(
        {
          address: wallet,
          scanning: true,
          state: walletRow?.scan_state,
          hitCount: walletRow?.scan_hit_count ?? 0,
          attempts: walletRow?.scan_attempts ?? 0,
        },
        {
          status: 202,
          headers: {
            ...gate.headers,
            ...corsHeaders(),
            'Cache-Control': 'no-store',
          },
        },
      );
    }
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
