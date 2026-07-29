import { NextRequest, NextResponse } from 'next/server';
import { getStats } from '@/db/client';
import { corsHeaders, corsPreflight, enforceRateLimit } from '@/lib/rate-limit';

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(request: NextRequest) {
  const gate = await enforceRateLimit('stats', request);
  if (!gate.ok) return gate.response;

  // getStats serves last-known-good figures across transient RPC failures and
  // throws only when it has nothing honest to return (cold start + DB down).
  // 503 that case uncached — a fabricated-zero 200 poisons the CDN and fires
  // the external counter-regression monitor (2026-07-29 incident).
  let stats;
  try {
    stats = await getStats();
  } catch (err) {
    console.error('[api/stats] unavailable:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: 'stats_unavailable' },
      { status: 503, headers: { ...gate.headers, ...corsHeaders(), 'Cache-Control': 'no-store' } },
    );
  }
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
