import { NextRequest, NextResponse } from 'next/server';
import { publishTopScores } from '@/integrations/publish';
import { DEFAULT_CHAIN, isChain, type Chain } from '@/db/schema';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 min — idempotency loop can be slow

/**
 * POST /api/cron/publish
 *
 * Authenticated cron trigger that publishes top karma scores to 8004 on-chain.
 * Called by Servel job (see `servel job add publish-karma ...`).
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` header required.
 * Body (optional): { "limit": number, "chain"?: Chain } — limit default 50,
 *   max 200; chain default 'solana', validated via isChain (400 on unknown).
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
  let chain: Chain = DEFAULT_CHAIN;
  try {
    const body = (await request.json().catch(() => ({}))) as { limit?: unknown; chain?: unknown };
    if (typeof body.limit === 'number' && body.limit > 0) {
      limit = Math.min(Math.floor(body.limit), 200);
    }
    if (body.chain !== undefined) {
      if (!isChain(body.chain)) {
        return NextResponse.json({ error: `Unknown chain: ${String(body.chain)}` }, { status: 400 });
      }
      chain = body.chain;
    }
  } catch {
    // ignore — use defaults
  }

  try {
    const result = await publishTopScores(limit, chain);
    return NextResponse.json(result);
  } catch (err) {
    console.error('[cron/publish] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Publish failed' },
      { status: 500 },
    );
  }
}
