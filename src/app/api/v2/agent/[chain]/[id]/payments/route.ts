/**
 * GET /api/v2/agent/[chain]/[id]/payments?limit=50&cursor=…
 *
 * Paged USDC payments RECEIVED by one registry agent, for API readers of
 * AgentKarma's API-only stellar-testnet index. Served ONLY for API-only chains; mainnet payment
 * ledgers are not exposed through this route.
 *
 * Response:
 *   { chain, network: 'testnet', agentId, address,
 *     asset: { code: 'USDC', issuer, sac, decimals: 7 },
 *     payments: [{ txHash, from, amount, timestamp, success }],
 *     nextCursor: string | null }
 *
 * `address` is the agent's bound wallet (agent_wallet, else owner) — the payee
 * matched against `transactions.counterparty`. `amount` is a decimal STRING in
 * whole USDC with exactly 7 decimals (Stellar USDC precision: 1 USDC = 10^7
 * base units), e.g. "0.0010000"; never a JSON number, so no float rounding.
 * Newest first; pass `nextCursor` back as `cursor` until it is null.
 */
import { NextRequest, NextResponse } from 'next/server';
import { decodePaymentsCursor, getReceivedPayments, getWalletByAgentId } from '@/db/client';
import { isApiOnlyChain } from '@/db/schema';
import { stellarNetwork } from '@/integrations/stellar-config';
import { corsHeaders, corsPreflight, enforceRateLimit } from '@/lib/rate-limit';

const MAX_INT32 = 2147483647;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

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

  const { chain, id } = await params;
  if (!isApiOnlyChain(chain)) {
    return NextResponse.json({ error: `payments are not served for chain '${chain}'` }, { status: 404, headers });
  }
  const agentId = Number(id);
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(agentId) || agentId > MAX_INT32) {
    return NextResponse.json({ error: 'agentId must be a nonnegative integer within int32 range' }, { status: 400, headers });
  }

  const sp = new URL(request.url).searchParams;
  const rawLimit = Number(sp.get('limit') ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_LIMIT) : DEFAULT_LIMIT;
  const rawCursor = sp.get('cursor');
  const cursor = rawCursor ? decodePaymentsCursor(rawCursor) : null;
  if (rawCursor && !cursor) {
    return NextResponse.json({ error: 'invalid cursor' }, { status: 400, headers });
  }

  const agent = await getWalletByAgentId(chain, agentId);
  if (!agent) {
    return NextResponse.json({ error: `no agent with id ${agentId} on ${chain}` }, { status: 404, headers });
  }

  const page = await getReceivedPayments(chain, agent.address, { limit, cursor });
  const { usdc } = stellarNetwork('testnet');
  return NextResponse.json(
    {
      chain,
      network: 'testnet',
      agentId,
      address: agent.address,
      asset: { code: usdc.code, issuer: usdc.issuer, sac: usdc.sac, decimals: usdc.decimals },
      ...page,
    },
    { headers: { ...headers, 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120' } },
  );
}
