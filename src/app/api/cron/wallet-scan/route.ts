import { NextRequest, NextResponse } from 'next/server';
import { recoverStuckScans } from '@/db/client';
import { runWalletScanWorker } from '@/indexer/wallet-scan';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/cron/wallet-scan
 *
 * Drains the wallet-scan queue: recovers rows stuck in 'scanning' past the
 * stale window, then scans the next pending wallet(s) via Helius. Mirrors the
 * in-process wallet-scan worker (src/instrumentation.ts) so background scan
 * work runs as an external Servel job instead of inside the user-facing web
 * process — keeping render latency and memory off the request path.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`.
 * Body (optional): `{ "batch": number, "staleMs": number }`
 *   batch:   wallets to scan this invocation (default 1, max 25 — bounds Helius load)
 *   staleMs: age past which a 'scanning' row is reclaimed (default 600000)
 *
 * Returns: { recovered, batch }
 *
 * Scheduled from Servel cron:
 *   servel job add wallet-scan --schedule "* * * * *" --app agentkarma \
 *     --command "curl -fsS -X POST -H 'Authorization: Bearer $CRON_SECRET' \
 *                https://agentkarma.io/api/cron/wallet-scan"
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

  let batch = 1;
  let staleMs = 600_000;
  try {
    const body = (await request.json().catch(() => ({}))) as {
      batch?: unknown;
      staleMs?: unknown;
    };
    if (typeof body.batch === 'number' && body.batch > 0) {
      batch = Math.min(Math.floor(body.batch), 25);
    }
    if (typeof body.staleMs === 'number' && body.staleMs > 0) {
      staleMs = Math.floor(body.staleMs);
    }
  } catch {
    // ignore — use defaults
  }

  try {
    const recovered = await recoverStuckScans(staleMs);
    await runWalletScanWorker(batch);
    return NextResponse.json({ recovered, batch }, { status: 200 });
  } catch (err) {
    console.error('[cron/wallet-scan] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Wallet scan failed' },
      { status: 500 },
    );
  }
}
