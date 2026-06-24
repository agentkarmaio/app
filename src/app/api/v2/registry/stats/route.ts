/**
 * GET /api/v2/registry/stats
 *
 * Per-chain ERC-8004 registry-mirror totals — agents (IdentityRegistry NFTs)
 * and feedbacks (ReputationRegistry records) AK has scanned. Matches the
 * per-network cards on 8004scan.io/networks. Sourced from erc8004_agents /
 * erc8004_feedback (HEAD counts, no row scan). Populated by the registry
 * scanner (src/indexer/erc8004-registry.ts).
 */

import { NextResponse } from 'next/server';
import { getRegistryStats } from '@/db/client';

export async function GET() {
  const chains = await getRegistryStats();
  const totals = chains.reduce(
    (acc, c) => ({ agents: acc.agents + c.agents, feedbacks: acc.feedbacks + c.feedbacks }),
    { agents: 0, feedbacks: 0 },
  );
  return NextResponse.json(
    { chains, totals },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}
