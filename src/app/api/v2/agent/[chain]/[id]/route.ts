/**
 * GET /api/v2/agent/[chain]/[id]
 *
 * Resolve an agent by chain + ERC-8004 agentId to its canonical AgentKarma
 * profile. Deep-link / SDK primitive: given `celo` + `9058`, returns the bound
 * wallet address, current Karma, and a ready-to-use profile URL.
 *
 * Mainnet resolves exact registry identity and recomputes both receipt faces.
 * Other chains read the scored `wallets` row (the AK projection) — for
 * the live IdentityRegistry record + reputation feedback use the per-chain
 * resolver (e.g. /api/v2/celo/[agentId]). Solana has no ERC-8004 agentId and is
 * rejected; look those agents up by address instead.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWalletByAgentId } from '@/db/client';
import { CHAINS, type Chain } from '@/db/schema';
import { agentHref } from '@/lib/agent-href';
import { resolveKarma } from '@/lib/karma-resolver';
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
  const isMainnet = chain === 'arc-mainnet';
  if (!Number.isInteger(agentId) || agentId < (isMainnet ? 0 : 1) || agentId > MAX_INT32 || (isMainnet && !/^\d+$/.test(id))) {
    return NextResponse.json(
      { error: `agentId must be a ${isMainnet ? 'nonnegative' : 'positive'} integer within int32 range` },
      { status: 400, headers },
    );
  }

  const wallet = await getWalletByAgentId(chain, agentId);
  if (!wallet) {
    return NextResponse.json({ error: `no agent with id ${agentId} on ${chain}` }, { status: 404, headers });
  }

  const snapshot = isMainnet ? await resolveKarma(wallet.address, chain, { agentId }) : null;
  if (isMainnet && !snapshot) {
    return NextResponse.json({ error: `no agent with id ${agentId} on ${chain}` }, { status: 404, headers });
  }

  return NextResponse.json(
    {
      chain,
      agentId,
      address: snapshot?.address ?? wallet.address,
      displayName: snapshot ? snapshot.identity.displayName ?? null : wallet.display_name ?? null,
      score: snapshot ? (snapshot.provider.hasSignal ? snapshot.provider.score : null) : Number(wallet.score),
      providerScore: snapshot ? (snapshot.provider.hasSignal ? snapshot.provider.score : null) : Number(wallet.provider_score),
      consumerScore: snapshot ? (snapshot.consumer.hasSignal ? snapshot.consumer.score : null)
        : wallet.consumer_score == null ? null : Number(wallet.consumer_score),
      trustTier: snapshot?.provider.trustTier ?? wallet.trust_tier,
      confidenceBadge: snapshot?.provider.confidenceBadge ?? wallet.confidence_badge,
      profileUrl: agentHref({ chain, address: snapshot?.address ?? wallet.address, agentId }),
    },
    {
      headers: {
        ...headers,
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
      },
    },
  );
}
