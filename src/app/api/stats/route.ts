import { NextRequest, NextResponse } from 'next/server';
import { getStats } from '@/db/client';
import { corsHeaders, corsPreflight, enforceRateLimit } from '@/lib/rate-limit';

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(request: NextRequest) {
  const gate = await enforceRateLimit('stats', request);
  if (!gate.ok) return gate.response;

  const stats = await getStats();
  return NextResponse.json(stats, {
    headers: {
      ...gate.headers,
      ...corsHeaders(),
      'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120',
    },
  });
}
