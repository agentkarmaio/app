/**
 * GET /api/v2/agent/[chain]/[id]
 *
 * Resolve an agent by chain + ERC-8004 agentId to its canonical AgentKarma
 * profile. Deep-link / SDK primitive: given `celo` + `9058`, returns the bound
 * wallet address, current Karma, and a ready-to-use profile URL.
 *
 * Reads the scored `wallets` row (the AK projection), not the raw registry — for
 * the live IdentityRegistry record + reputation feedback use the per-chain
 * resolver (e.g. /api/v2/celo/[agentId]). Solana has no ERC-8004 agentId and is
 * rejected; look those agents up by address instead.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWalletByAgentId } from '@/db/client';
import { CHAINS, type Chain } from '@/db/schema';
import { agentHref } from '@/lib/agent-href';
import { corsHeaders, corsPreflight, enforceRateLimit } from '@/lib/rate-limit';

const MAX_INT32 = 2147483647;

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ chain: string; id: string }> },
) {
  const gate = await enforceRateLimit('score', request);
  if (!gate.ok) return gate.response;

  const headers = { ...gate.headers, ...corsHeaders() };
  const { chain: chainParam, id } = await params;

  if (!CHAINS.includes(chainParam as Chain)) {
    return NextResponse.json({ error: `unknown chain '${chainParam}'` }, { status: 400, headers });
  }
  const chain = chainParam as Chain;
  if (chain === 'solana') {
    return NextResponse.json(
      { error: 'Solana agents have no ERC-8004 agentId; look up by address instead' },
      { status: 400, headers },
    );
  }

  const agentId = Number(id);
  if (!Number.isInteger(agentId) || agentId <= 0 || agentId > MAX_INT32) {
    return NextResponse.json(
      { error: 'agentId must be a positive integer within int32 range' },
      { status: 400, headers },
    );
  }

  const wallet = await getWalletByAgentId(chain, agentId);
  if (!wallet) {
    return NextResponse.json({ error: `no agent with id ${agentId} on ${chain}` }, { status: 404, headers });
  }

  return NextResponse.json(
    {
      chain,
      agentId,
      address: wallet.address,
      displayName: wallet.display_name ?? null,
      score: Number(wallet.score),
      providerScore: Number(wallet.provider_score),
      consumerScore: wallet.consumer_score == null ? null : Number(wallet.consumer_score),
      trustTier: wallet.trust_tier,
      confidenceBadge: wallet.confidence_badge,
      profileUrl: agentHref({ chain, address: wallet.address, agentId }),
    },
    {
      headers: {
        ...headers,
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
      },
    },
  );
}
