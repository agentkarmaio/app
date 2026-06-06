import { NextRequest, NextResponse } from 'next/server';
import { checkOnce } from '@/lib/helius-watchdog';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/cron/helius-watchdog
 *
 * Polls the Helius webhook registry once and re-enables our enhanced webhook
 * if Helius auto-disabled it (24h of delivery failures, deploy blip, etc.).
 * Mirrors the in-process watchdog (src/lib/helius-watchdog.ts) so it runs as
 * an external Servel job instead of an in-process interval inside the web
 * server.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`.
 * Body (optional): `{ "urlHint": string }` — webhook URL substring to match.
 *
 * Returns: WatchdogTick { matched, active, reEnabled, errors }, or
 *          { skipped: 'no-api-key' } when no Helius credentials are set.
 *
 * Scheduled from Servel cron:
 *   servel job add helius-watchdog --schedule "*\/5 * * * *" --app agentkarma \
 *     --command "curl -fsS -X POST -H 'Authorization: Bearer $CRON_SECRET' \
 *                https://agentkarma.io/api/cron/helius-watchdog"
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

  let urlHint: string | undefined;
  try {
    const body = (await request.json().catch(() => ({}))) as { urlHint?: unknown };
    if (typeof body.urlHint === 'string' && body.urlHint.trim()) {
      urlHint = body.urlHint.trim();
    }
  } catch {
    // ignore — use default hint
  }

  try {
    const tick = await checkOnce(urlHint);
    if (!tick) {
      return NextResponse.json({ skipped: 'no-api-key' }, { status: 200 });
    }
    const status = tick.errors.length > 0 ? 207 : 200;
    return NextResponse.json(tick, { status });
  } catch (err) {
    console.error('[cron/helius-watchdog] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Watchdog check failed' },
      { status: 500 },
    );
  }
}
