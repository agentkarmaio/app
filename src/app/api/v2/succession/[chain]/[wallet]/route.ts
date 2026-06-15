/**
 * GET /api/v2/succession/{chain}/{wallet}
 *
 * The agent's declared succession plan (Dead Man's Switch) + AK's OBSERVED
 * heartbeat liveness. AK never holds a key, never holds funds, never executes a
 * will (RFC §12 Non-Routing AND Non-Custody) — this is a read-only projection
 * of the public lifecycle plus a pure liveness derivation.
 *
 * 404 when the agent has declared no succession plan. Read-only, public,
 * CORS-enabled — same shape conventions as `/api/v2/score/[wallet]/route.ts`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSuccession, getRecentTransactionsForWallet } from '@/db/client';
import { deriveSuccessionLiveness } from '@/scoring/succession';
import { resolveChainParam } from '@/lib/chain-detect';
import { corsHeaders, corsPreflight, enforceRateLimit } from '@/lib/rate-limit';
import { buildSuccessionView, type SuccessionView } from '@/lib/succession-view';

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ chain: string; wallet: string }> },
) {
  const gate = await enforceRateLimit('succession-get', request);
  if (!gate.ok) return gate.response;

  const { chain: chainParam, wallet } = await params;

  const chain = resolveChainParam(chainParam, wallet);
  if (!chain) {
    return NextResponse.json(
      { error: 'Invalid chain or wallet for chain' },
      { status: 400, headers: { ...gate.headers, ...corsHeaders() } },
    );
  }

  const succession = await getSuccession(wallet, chain);
  if (!succession) {
    return NextResponse.json(
      { error: 'No succession plan declared for this agent' },
      { status: 404, headers: { ...gate.headers, ...corsHeaders() } },
    );
  }

  // The heartbeat is the agent's last meaningful tx. Bounded fetch; we only
  // need the most-recent one. Empty for chains/agents without indexed txs.
  let lastTxAt: string | null = null;
  try {
    const recent = await getRecentTransactionsForWallet(wallet, 1);
    lastTxAt = recent[0]?.timestamp ?? null;
  } catch {
    lastTxAt = null;
  }

  const liveness = deriveSuccessionLiveness({
    succession: { status: succession.status, interval_seconds: succession.interval_seconds },
    lastMeaningfulTxAt: lastTxAt ?? succession.last_heartbeat_at,
  });

  const view: SuccessionView = buildSuccessionView(succession, liveness);

  return NextResponse.json(
    { chain, address: wallet, succession: view },
    {
      headers: {
        ...gate.headers,
        ...corsHeaders(),
        'Cache-Control': 'public, max-age=60',
      },
    },
  );
}

export type { SuccessionView };
