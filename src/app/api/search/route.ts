import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/db/client';
import type { Wallet } from '@/db/schema';
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

  const { data, error } = await supabase
    .from('wallets')
    .select('address, score, trust_tier, tx_count')
    .ilike('address', `%${q}%`)
    .order('score', { ascending: false })
    .limit(8);

  if (error) throw error;

  const results = ((data ?? []) as Pick<Wallet, 'address' | 'score' | 'trust_tier' | 'tx_count'>[]).map((w) => ({
    address: w.address,
    score: Number(w.score),
    trustTier: w.trust_tier,
    txCount: w.tx_count,
  }));

  return NextResponse.json({ results }, {
    headers: {
      ...gate.headers,
      ...corsHeaders(),
      'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120',
    },
  });
}
