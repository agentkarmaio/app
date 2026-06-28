import { NextRequest, NextResponse } from 'next/server';
import { searchWallets } from '@/db/client';
import { corsHeaders, corsPreflight, enforceRateLimit } from '@/lib/rate-limit';

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(request: NextRequest) {
  const gate = await enforceRateLimit('search', request);
  if (!gate.ok) return gate.response;

  const q = request.nextUrl.searchParams.get('q')?.trim();
  if (!q || q.length < 3) {
    return NextResponse.json({ results: [] }, {
      headers: { ...gate.headers, ...corsHeaders() },
    });
  }

  // Matches address OR display_name OR exact ERC-8004 agentId across all chains.
  // `chain` + `displayName` + `agentId` let the client render the agent's name +
  // chain badge and link chain-aware (agentId disambiguates EVM owners).
  const rows = await searchWallets(q, 8);
  const results = rows.map((w) => ({
    address: w.address,
    chain: w.chain,
    displayName: w.displayName,
    score: w.score,
    trustTier: w.trustTier,
    txCount: w.txCount,
    agentId: w.agentId,
  }));

  return NextResponse.json({ results }, {
    headers: {
      ...gate.headers,
      ...corsHeaders(),
      'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120',
    },
  });
}
