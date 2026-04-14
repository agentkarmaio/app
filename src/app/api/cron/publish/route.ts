import { NextRequest, NextResponse } from 'next/server';
import { publishTopScores } from '@/integrations/publish';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 min — idempotency loop can be slow

/**
 * POST /api/cron/publish
 *
 * Authenticated cron trigger that publishes top karma scores to 8004 on-chain.
 * Called by Servel job (see `servel job add publish-karma ...`).
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` header required.
 * Body (optional): { "limit": number } — default 50, max 200.
 *
 * Returns: { published, skipped, errors, dryRun, details }
 */
export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'CRON_SECRET not configured on server' },
      { status: 500 },
    );
  }

  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let limit = 50;
  try {
    const body = (await request.json().catch(() => ({}))) as { limit?: unknown };
    if (typeof body.limit === 'number' && body.limit > 0) {
      limit = Math.min(Math.floor(body.limit), 200);
    }
  } catch {
    // ignore — use default
  }

  try {
    const result = await publishTopScores(limit);
    return NextResponse.json(result);
  } catch (err) {
    console.error('[cron/publish] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Publish failed' },
      { status: 500 },
    );
  }
}
