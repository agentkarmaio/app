import { NextRequest, NextResponse } from 'next/server';
import { getRegistryConfig } from '@/config/erc8004-registries';
import { runIncrementalRegistryScan } from '@/indexer/erc8004-registry';
import {
  upsertErc8004Agents,
  upsertErc8004Feedback,
  getRegistryCursorTip,
  setRegistryCursorTip,
} from '@/db/client';
import type { Chain } from '@/db/schema';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/cron/registry-scan
 *
 * Scheduled INCREMENTAL refresh of the ERC-8004 registry mirror (erc8004_agents
 * / erc8004_feedback) the /celo page reads. Replaces the manual `registry:scan`.
 * Mirrors POST /api/cron/indexer-celo (same auth + chain scope: Celo only — the
 * registry-scanner supports Arc too, add a chain there when indexer-celo does).
 *
 * Cheap by design: reads the cursor in indexer_cursors (`celo:registry`), scans
 * only NEW ids since the last run PLUS a bounded recent re-scan window, and
 * advances the cursor. It is NEVER the full ~9.6k-id / ~12-min sweep — that
 * stays the manual `bun run registry:scan` (full) path.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`.
 * Body (optional): `{ "rescanWindow": number }` — recent ids to re-scan (default 500).
 *
 * Drive from an external scheduler (GitHub Actions / cron-job.org), same as
 * /api/cron/indexer-celo — servel cron is non-functional on this cluster.
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

  const chain: Chain = 'celo';
  const config = getRegistryConfig(chain);
  if (!config) {
    return NextResponse.json(
      { error: `no ERC-8004 registry config for chain '${chain}'` },
      { status: 500 },
    );
  }

  let rescanWindow: number | undefined;
  try {
    const body = (await request.json().catch(() => ({}))) as { rescanWindow?: unknown };
    if (typeof body.rescanWindow === 'number' && body.rescanWindow > 0) {
      rescanWindow = Math.floor(body.rescanWindow);
    }
  } catch {
    // ignore — use defaults
  }

  try {
    const result = await runIncrementalRegistryScan(
      config,
      upsertErc8004Agents,
      upsertErc8004Feedback,
      (c) => getRegistryCursorTip(c as Chain),
      (c, tip) => setRegistryCursorTip(c as Chain, tip),
      { rescanWindow, onProgress: (m) => console.log(`[cron/registry-scan] ${m}`) },
    );
    return NextResponse.json(
      {
        chain: result.chain,
        tip: result.tip,
        agentsScanned: result.agentsScanned,
        agentsPersisted: result.agentsPersisted,
        feedbackScanned: result.feedbackScanned,
        feedbackPersisted: result.feedbackPersisted,
        errors: result.errors,
      },
      { status: 200 },
    );
  } catch (err) {
    console.error('[cron/registry-scan] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'registry scan run failed' },
      { status: 500 },
    );
  }
}
