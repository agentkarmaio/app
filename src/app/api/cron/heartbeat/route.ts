import { NextRequest, NextResponse } from 'next/server';
import { drainHeartbeatsOnce } from '@/successions/heartbeat-worker';
import { isChain } from '@/db/schema';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/cron/heartbeat
 *
 * Drives the Dead Man's Switch heartbeat drain across ALL chains: for every
 * declared, non-terminal succession it derives liveness from the agent's last
 * meaningful tx, emits a Tier-2 heartbeat_observed / heartbeat_lapsed signal,
 * and persists the derived status. AK never executes a will — pure observation.
 *
 * Webhook-independent floor (mirrors /api/cron/rescore + /api/cron/indexer):
 * the in-process worker (instrumentation.ts) is the fast path; this route is the
 * defense-in-depth layer driven by GitHub Actions, so a wedged app never silently
 * stalls liveness (see the 2026-05/06 ingest-freshness incident).
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`.
 * Body (optional): `{ "limit": number, "chain": Chain }`
 *   limit: max successions to evaluate this pass (default 500, max 2000)
 *   chain: restrict to one chain (default: all chains)
 *
 * Returns: { claimed, transitioned, observed, lapsed, skipped, errors, elapsedMs }
 */
export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'CRON_SECRET not configured on server' },
      { status: 500 },
    );
  }

  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let limit = 500;
  let chain;
  try {
    const body = (await request.json().catch(() => ({}))) as { limit?: unknown; chain?: unknown };
    if (typeof body.limit === 'number' && body.limit > 0) {
      limit = Math.min(Math.floor(body.limit), 2000);
    }
    if (typeof body.chain === 'string') {
      if (!isChain(body.chain)) {
        return NextResponse.json({ error: `Unknown chain: ${body.chain}` }, { status: 400 });
      }
      chain = body.chain;
    }
  } catch {
    // ignore — use defaults
  }

  try {
    const result = await drainHeartbeatsOnce(limit, chain);
    const status = result.errors.length > 0 ? 207 : 200;
    return NextResponse.json(result, { status });
  } catch (err) {
    console.error('[cron/heartbeat] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Heartbeat drain failed' },
      { status: 500 },
    );
  }
}
