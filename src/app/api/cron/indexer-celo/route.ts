import { NextRequest, NextResponse } from 'next/server';
import { runCeloX402Indexer } from '@/indexer/celo-x402';
import { celoX402FacilitatorSetWithDiscovered } from '@/config/celo-x402';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/cron/indexer-celo
 *
 * Scheduled, webhook-independent poll of Celo USDC/USDT/USDm `Transfer` events
 * into Tier-1 x402 receipts. Mirrors POST /api/cron/indexer (the Solana floor)
 * and /api/cron/indexer-stellar.
 *
 * Dormant until seeded: returns `{ fetched: 0, skipped }` while
 * CELO_X402_FACILITATORS is empty (src/config/celo-x402.ts + the env override).
 * Seed a verified resource-server/payee address — via code or the
 * CELO_X402_FACILITATORS env (comma-separated) — and this starts ingesting.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`.
 * Body (optional): `{ "windowSize": number, "maxWindows": number }`.
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
  // Uses the merged set (curated + env + verified self-seeded payees) so a run
  // driven purely by discovered payees is not falsely reported as dormant.
  if ((await celoX402FacilitatorSetWithDiscovered()).size === 0) {
    return NextResponse.json(
      {
        fetched: 0,
        inserted: 0,
        skipped:
          'no Celo x402 facilitator/payee seeded — add one to src/config/celo-x402.ts, ' +
          'the CELO_X402_FACILITATORS env, or run scripts/celo-x402-discover-payees.ts',
      },
      { status: 200 },
    );
  }

  let windowSize: number | undefined;
  let maxWindows: number | undefined;
  try {
    const body = (await request.json().catch(() => ({}))) as {
      windowSize?: unknown;
      maxWindows?: unknown;
    };
    if (typeof body.windowSize === 'number' && body.windowSize > 0) {
      windowSize = Math.floor(body.windowSize);
    }
    if (typeof body.maxWindows === 'number' && body.maxWindows > 0) {
      maxWindows = Math.floor(body.maxWindows);
    }
  } catch {
    // ignore — use defaults
  }

  try {
    const result = await runCeloX402Indexer({ windowSize, maxWindows });
    return NextResponse.json(
      {
        fetched: result.fetched,
        inserted: result.inserted,
        cursors: Object.fromEntries(result.cursors),
      },
      { status: 200 },
    );
  } catch (err) {
    console.error('[cron/indexer-celo] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Celo indexer run failed' },
      { status: 500 },
    );
  }
}
