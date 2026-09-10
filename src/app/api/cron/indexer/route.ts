import { NextRequest, NextResponse } from 'next/server';
import { runIndexer } from '@/indexer/index';
import { getRecentTransactions } from '@/db/client';
import { assessIngestFreshness } from '@/lib/ingest-health';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/cron/indexer
 *
 * Polls every known x402 facilitator via Helius RPC and ingests new
 * transactions — the scheduled, webhook-independent FLOOR for ingest.
 *
 * The real-time path is the Helius push webhook (/api/webhook/helius). This
 * endpoint is the polling backstop: when that webhook is disabled (it sat
 * silently dead 2026-05-21 → 06-06, 17 days, with no fallback) this still
 * keeps data fresh. Cursor-based + idempotent (tx_signature unique).
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`.
 * Body (optional): `{ "limit": number, "backfill": boolean }`
 *   limit:    signatures fetched per facilitator (default 200, max 1000)
 *   backfill: ignore cursors and fetch historical (default false)
 *
 * Returns: the runIndexer result plus `freshness` — the post-run staleness
 * assessment (severity fresh|warning|critical|unknown). 207 if still critical,
 * or if any signature was served by no RPC (`unresolved > 0` — a degraded run).
 *
 * Drive from any external scheduler (GitHub Actions, cron-job.org). The
 * in-process indexer worker (instrumentation.ts) mirrors this for the
 * app-healthy fast path; servel cron is non-functional on this cluster.
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
  let backfill = false;
  try {
    const body = (await request.json().catch(() => ({}))) as {
      limit?: unknown;
      backfill?: unknown;
    };
    if (typeof body.limit === 'number' && body.limit > 0) {
      limit = Math.min(Math.floor(body.limit), 1000);
    }
    if (typeof body.backfill === 'boolean') {
      backfill = body.backfill;
    }
  } catch {
    // ignore — use defaults
  }

  try {
    const result = await runIndexer(limit, { backfill });

    const latestTx = (await getRecentTransactions(undefined, 1))[0];
    const lastTxIso = latestTx
      ? new Date(latestTx.timestamp as string | Date).toISOString()
      : null;
    const freshness = assessIngestFreshness(lastTxIso, Date.now());

    if (freshness.severity === 'critical') {
      console.error('[cron/indexer] ingest still critical after run', freshness);
    }

    // 207 for unresolved too: an external scheduler that alerts on status must
    // not read a run that could not obtain transactions as a clean 200. Cursors
    // were held, so nothing is lost yet — but only until those signatures scroll
    // out of the fetched window.
    const degraded = freshness.severity === 'critical' || result.unresolved > 0;
    if (result.unresolved > 0) {
      console.error(
        `[cron/indexer] DEGRADED: ${result.unresolved} signature(s) served by no RPC ` +
        '— cursors held, see [indexer] warnings for the signature list',
      );
    }

    return NextResponse.json(
      { ...result, freshness },
      { status: degraded ? 207 : 200 },
    );
  } catch (err) {
    console.error('[cron/indexer] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Indexer run failed' },
      { status: 500 },
    );
  }
}
