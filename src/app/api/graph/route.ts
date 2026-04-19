import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/db/client';
import { getLeaderboard } from '@/db/client';
import type { Transaction } from '@/db/schema';
import { corsHeaders, corsPreflight, enforceRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(request: NextRequest) {
  const gate = await enforceRateLimit('graph', request);
  if (!gate.ok) return gate.response;

  const { wallets: agents } = await getLeaderboard(24);
  if (agents.length === 0) {
    return NextResponse.json({ facilitator: null, agents: [] }, {
      headers: {
        ...gate.headers,
        ...corsHeaders(),
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120',
      },
    });
  }

  const addresses = agents.map((a) => a.address);

  const { data: txs, error } = await supabase
    .from('transactions')
    .select('wallet_address, facilitator')
    .in('wallet_address', addresses);
  if (error) throw error;

  const facilitatorCounts = new Map<string, number>();
  const agentFacilitator = new Map<string, Map<string, number>>();

  for (const t of (txs ?? []) as Pick<Transaction, 'wallet_address' | 'facilitator'>[]) {
    facilitatorCounts.set(t.facilitator, (facilitatorCounts.get(t.facilitator) ?? 0) + 1);
    const inner = agentFacilitator.get(t.wallet_address) ?? new Map<string, number>();
    inner.set(t.facilitator, (inner.get(t.facilitator) ?? 0) + 1);
    agentFacilitator.set(t.wallet_address, inner);
  }

  const topFacilitator =
    [...facilitatorCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return NextResponse.json({
    facilitator: topFacilitator,
    agents: agents.map((a) => {
      const fMap = agentFacilitator.get(a.address);
      const primary = fMap
        ? [...fMap.entries()].sort((x, y) => y[1] - x[1])[0]?.[0]
        : null;
      return {
        address: a.address,
        displayName: a.display_name,
        score: Number(a.score),
        trustTier: a.trust_tier,
        txCount: a.tx_count,
        primaryFacilitator: primary,
      };
    }),
  }, {
    headers: {
      ...gate.headers,
      ...corsHeaders(),
      'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120',
    },
  });
}
