import { NextRequest, NextResponse } from 'next/server';
import { readIndexingStates } from '@/db/indexing-state';
import { buildIndexingHealth } from '@/lib/indexing-health';
import { corsHeaders, corsPreflight, enforceRateLimit } from '@/lib/rate-limit';

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(request: NextRequest) {
  const gate = await enforceRateLimit('stats', request);
  const publicHeaders = { ...corsHeaders(), 'Cache-Control': 'no-store' };
  if (!gate.ok) {
    for (const [name, value] of Object.entries(publicHeaders)) gate.response.headers.set(name, value);
    return gate.response;
  }
  const headers = { ...gate.headers, ...publicHeaders };
  try {
    return NextResponse.json(buildIndexingHealth(await readIndexingStates()), { headers });
  } catch {
    return NextResponse.json({ error: 'indexing_status_unavailable' }, { status: 503, headers });
  }
}
