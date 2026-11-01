/**
 * GET /api/v2/payments/[chain]?limit=500&cursor=…
 *
 * Every USDC transfer leg AgentKarma has indexed on an API-only chain
 * (stellar-testnet), in the order it was stored, for consumers that keep their
 * own copy and apply their own rules (an external indexer can read it
 * instead of polling Horizon per wallet). Not per agent, and no revenue
 * judgement: for counted/excluded totals use
 * GET /api/v2/agent/{chain}/{id}/payments.
 *
 * Response:
 *   { chain, network: 'testnet',
 *     asset: { code: 'USDC', issuer, sac, decimals: 7 },
 *     payments: [{ id, txHash, from, to, amount, timestamp, success }],
 *     cursor: string | null, done: boolean }
 *
 * `id` is "<operationId>:<legIndex>" (unique). `amount` is a decimal string
 * with exactly 7 decimals. `timestamp` is chain time. Pass `cursor` back to
 * continue; `done` is true when this page reached the end of what is stored
 * (poll again later with the same cursor). Rows stored in the last two minutes
 * are held back so a row committed late is never skipped.
 */
import { NextRequest, NextResponse } from 'next/server';
import { decodePaymentsCursor, getPaymentFeed } from '@/db/client';
import { isApiOnlyChain } from '@/db/schema';
import { stellarNetwork } from '@/integrations/stellar-config';
import { corsHeaders, corsPreflight, enforceRateLimit } from '@/lib/rate-limit';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ chain: string }> }) {
  const gate = await enforceRateLimit('payment-feed', request);
  if (!gate.ok) return gate.response;
  const headers = { ...gate.headers, ...corsHeaders() };

  const { chain } = await params;
  if (!isApiOnlyChain(chain)) {
    return NextResponse.json({ error: `the payment feed is not served for chain '${chain}'` }, { status: 404, headers });
  }
  const sp = new URL(request.url).searchParams;
  const rawLimit = Number(sp.get('limit') ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_LIMIT) : DEFAULT_LIMIT;
  const rawCursor = sp.get('cursor');
  const cursor = rawCursor ? decodePaymentsCursor(rawCursor) : null;
  if (rawCursor && !cursor) {
    return NextResponse.json({ error: 'invalid cursor' }, { status: 400, headers });
  }

  const page = await getPaymentFeed(chain, { limit, cursor });
  const { usdc } = stellarNetwork('testnet');
  return NextResponse.json(
    { chain, network: 'testnet', asset: { code: usdc.code, issuer: usdc.issuer, sac: usdc.sac, decimals: usdc.decimals }, ...page },
    { headers: { ...headers, 'Cache-Control': 'no-store' } },
  );
}
