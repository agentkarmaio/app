import { NextRequest, NextResponse } from 'next/server';
import { runStellarIndexer } from '@/indexer/stellar-x402';
import { STELLAR_FACILITATOR_SET, STELLAR_MPP_RECIPIENTS } from '@/config/stellar-x402';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/cron/indexer-stellar
 *
 * Scheduled, webhook-independent poll of Stellar USDC SAC `transfer` events into
 * x402 / MPP Tier-1 receipts. Mirrors POST /api/cron/indexer (the Solana floor).
 *
 * Dormant until configured: returns `{ fetched: 0, skipped }` while
 * STELLAR_FACILITATORS / STELLAR_MPP_RECIPIENTS are empty (src/config/stellar-x402.ts).
 * Seed them with src/scripts/stellar-facilitator-probe.ts and set STELLAR_RPC_URL,
 * then this starts ingesting.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`.
 * Body (optional): `{ "limit": number }` — SAC events per pass (default 200, max 1000).
 *
 * Drive from an external scheduler (GitHub Actions / cron-job.org), same as
 * /api/cron/indexer — servel cron is non-functional on this cluster.
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

  // Honest dormant signal in the scheduler log: nothing to match until seeded.
  if (STELLAR_FACILITATOR_SET.size === 0 && STELLAR_MPP_RECIPIENTS.size === 0) {
    return NextResponse.json(
      {
        fetched: 0,
        inserted: 0,
        skipped:
          'STELLAR_FACILITATORS / STELLAR_MPP_RECIPIENTS not seeded — run src/scripts/stellar-facilitator-probe.ts',
      },
      { status: 200 },
    );
  }

  let limit = 200;
  try {
    const body = (await request.json().catch(() => ({}))) as { limit?: unknown };
    if (typeof body.limit === 'number' && body.limit > 0) {
      limit = Math.min(Math.floor(body.limit), 1000);
    }
  } catch {
    // ignore — use defaults
  }

  try {
    const result = await runStellarIndexer({ limit });
    return NextResponse.json(
      {
        fetched: result.fetched,
        inserted: result.inserted,
        cursors: Object.fromEntries(result.cursors),
      },
      { status: 200 },
    );
  } catch (err) {
    console.error('[cron/indexer-stellar] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Stellar indexer run failed' },
      { status: 500 },
    );
  }
}
