/**
 * GET /api/v2/succession/reapable?chain=&limit=&offset=&status=
 *
 * The public "Agent Estates" feed: agents whose declared succession plan has
 * gone lapsing / lapsed / executed — i.e. the estate is becoming (or is)
 * claimable by the declared heirs. AK only OBSERVES and lists; it never holds a
 * key, never moves funds, never executes a will (RFC §12 Non-Custody).
 *
 * Paginated, chain-filterable. Read-only, public, CORS-enabled.
 *
 *   ?chain=solana|celo|arc|stellar   restrict to one chain (default: all)
 *   ?status=lapsing,lapsed,executed  override the reapable set (subset only)
 *   ?limit=  1..100  (default 25)
 *   ?offset= >=0     (default 0)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getReapableSuccessions, REAPABLE_STATUSES } from '@/db/client';
import { isChain, type Chain, type SuccessionStatus } from '@/db/schema';
import { corsHeaders, corsPreflight } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function OPTIONS() {
  return corsPreflight();
}

const REAPABLE_SET = new Set<SuccessionStatus>(REAPABLE_STATUSES);

export interface ReapableEstateView {
  chain: string;
  address: string;
  status: SuccessionStatus;
  intervalSeconds: number;
  heirCount: number;
  lastHeartbeatAt: string | null;
  lapsedAt: string | null;
  executedAt: string | null;
  declaredAt: string;
}

export interface ReapableResponse {
  generatedAt: string;
  total: number;
  limit: number;
  offset: number;
  statuses: SuccessionStatus[];
  estates: ReapableEstateView[];
}

export async function GET(request: NextRequest) {
  const sp = new URL(request.url).searchParams;

  const chainParam = sp.get('chain');
  if (chainParam && !isChain(chainParam)) {
    return NextResponse.json(
      { error: 'Unknown chain' },
      { status: 400, headers: corsHeaders() },
    );
  }
  const chainFilter: Chain | undefined = chainParam && isChain(chainParam) ? chainParam : undefined;

  const limit = clampInt(sp.get('limit'), 25, 1, 100);
  const offset = clampInt(sp.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);

  // Optional status subset — must stay within the reapable set (no peeking at
  // live/declared/revoked agents through this public feed).
  let statuses: SuccessionStatus[] | undefined;
  const statusParam = sp.get('status');
  if (statusParam) {
    const requested = statusParam.split(',').map((s) => s.trim()).filter(Boolean);
    const valid = requested.filter((s): s is SuccessionStatus =>
      REAPABLE_SET.has(s as SuccessionStatus));
    if (valid.length === 0) {
      return NextResponse.json(
        { error: `status must be a subset of: ${REAPABLE_STATUSES.join(', ')}` },
        { status: 400, headers: corsHeaders() },
      );
    }
    statuses = valid;
  }

  const { successions, total } = await getReapableSuccessions(limit, offset, {
    chain: chainFilter,
    statuses,
  });

  const estates: ReapableEstateView[] = successions.map((s) => ({
    chain: s.chain,
    address: s.agent_wallet,
    status: s.status,
    intervalSeconds: s.interval_seconds,
    heirCount: Array.isArray(s.heirs) ? s.heirs.length : 0,
    lastHeartbeatAt: s.last_heartbeat_at,
    lapsedAt: s.lapsed_at,
    executedAt: s.executed_at,
    declaredAt: s.declared_at,
  }));

  const body: ReapableResponse = {
    generatedAt: new Date().toISOString(),
    total,
    limit,
    offset,
    statuses: statuses ?? REAPABLE_STATUSES,
    estates,
  };

  return NextResponse.json(body, {
    headers: {
      ...corsHeaders(),
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=120',
    },
  });
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
