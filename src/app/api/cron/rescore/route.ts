import { NextRequest, NextResponse } from 'next/server';
import { drainOnce } from '@/scripts/rescore-dirty';
import { DEFAULT_TX_WINDOW } from '@/db/client';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/cron/rescore
 *
 * Drains the deferred-scoring queue (wallets.scoring_dirty_at) — a batch of
 * wallets that had new txs land via the webhook and now need their cadence /
 * autonomy / karma score recomputed.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`.
 * Body (optional): `{ "limit": number, "txWindow": number }`
 *   limit:    max wallets to score this invocation (default 200, max 1000)
 *   txWindow: recent-tx rows per wallet fed to scoring (default 5000, max 10000)
 *
 * Returns: { claimed, scored, skipped, errors, remaining, elapsedMs }
 *
 * Scheduled from Servel cron:
 *   servel job add rescore-karma --schedule "* * * * *" --app agentkarma \
 *     --command "curl -fsS -X POST -H 'Authorization: Bearer $CRON_SECRET' \
 *                https://agentkarma.io/api/cron/rescore"
 *
 * Can also be driven from any external scheduler (GitHub Actions, Cloudflare
 * Workers, cron-job.org) — the endpoint is self-contained and idempotent.
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

  let limit = 200;
  let txWindow = DEFAULT_TX_WINDOW;
  try {
    const body = (await request.json().catch(() => ({}))) as {
      limit?: unknown;
      txWindow?: unknown;
    };
    if (typeof body.limit === 'number' && body.limit > 0) {
      limit = Math.min(Math.floor(body.limit), 1000);
    }
    if (typeof body.txWindow === 'number' && body.txWindow > 0) {
      txWindow = Math.min(Math.floor(body.txWindow), 10000);
    }
  } catch {
    // ignore — use defaults
  }

  try {
    const result = await drainOnce(limit, txWindow);
    const status = result.errors.length > 0 ? 207 : 200;
    return NextResponse.json(result, { status });
  } catch (err) {
    console.error('[cron/rescore] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Rescore failed' },
      { status: 500 },
    );
  }
}
