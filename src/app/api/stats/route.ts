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
      // Live counter polls this every 6s with cache:'no-store' on the client.
      // Keep the CDN window tight so the visible count moves with real ingest
      // instead of plateauing for 30+ seconds at off-peak rates.
      'Cache-Control': 'public, s-maxage=5, stale-while-revalidate=20',
    },
  });
}
