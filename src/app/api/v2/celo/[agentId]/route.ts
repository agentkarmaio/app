/**
 * GET /api/v2/celo/[agentId]
 *
 * Resolves a Celo ERC-8004 agent: returns IdentityRegistry record + parsed
 * agent registration JSON + aggregate reputation summary.
 *
 * On-demand RPC read against Celo mainnet — no DB caching yet (Phase 1).
 * Caching layer lands when the indexer (#5) materializes Celo agent rows
 * into the wallets table.
 */

import { NextResponse } from 'next/server';
import { readAgent, aggregateFeedback } from '@/integrations/erc8004-celo';

interface RouteParams {
  params: Promise<{ agentId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { agentId: raw } = await params;

  // Parse + validate. ERC-8004 agentIds are sequential uint256 starting at 1.
  // We accept decimal strings up to safe bounds; downstream code uses bigint.
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    return NextResponse.json(
      { error: 'agentId must be a positive integer' },
      { status: 400 },
    );
  }

  try {
    const agentId = BigInt(parsed);
    const [agent, agg] = await Promise.all([
      readAgent(agentId),
      aggregateFeedback(agentId).catch(() => null),
    ]);

    if (!agent) {
      return NextResponse.json(
        { error: `no agent registered with id ${parsed} on Celo` },
        { status: 404 },
      );
    }

    return NextResponse.json(
      {
        chain: 'celo',
        agentId: parsed,
        owner: agent.owner,
        agentWallet: agent.agentWallet,
        tokenURI: agent.tokenURI,
        registration: agent.registration ?? null,
        registrationError: agent.registrationError,
        reputation: agg
          ? {
              count: agg.count,
              average: agg.average,
              records: agg.records.map((r) => ({
                client: r.client,
                value: r.value,
                tag1: r.tag1,
                tag2: r.tag2,
                revoked: r.revoked,
              })),
            }
          : null,
        explorer: {
          celoscan: `https://celoscan.io/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a=${parsed}`,
          eightthousandfourscan: `https://8004scan.io/agent/${parsed}`,
        },
      },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900',
          'Access-Control-Allow-Origin': '*',
        },
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: 'failed to resolve agent', detail: msg },
      { status: 502 },
    );
  }
}
