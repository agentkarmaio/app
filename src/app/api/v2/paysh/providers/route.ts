/**
 * GET /api/v2/paysh/providers
 *
 * Joins the live pay.sh catalog (fetched + cached for 1h) with AgentKarma's
 * Provider Karma scores. Returns a stable, sorted list ranked by Provider
 * Karma (descending). Providers without a known operator-id mapping return
 * an empty `walletScores[]` and rank below scored providers.
 *
 * Read-only, public, CORS-enabled — same shape conventions as
 * `/api/v2/score/[wallet]/route.ts`.
 */
import { NextResponse } from 'next/server';
import { fetchPayshCatalog, type PayshCatalogProvider } from '@/lib/paysh-catalog';
import { PAYSH_OPERATORS, type PayshOperatorId } from '@/config/paysh-operators';
import { getWallet } from '@/db/client';
import { corsHeaders, corsPreflight } from '@/lib/rate-limit';
import type { ConfidenceBadge, TrustTier } from '@/db/schema';

export const dynamic = 'force-dynamic';

export async function OPTIONS() {
  return corsPreflight();
}

interface WalletScoreView {
  address: string;
  providerScore: number;
  trustTier: TrustTier;
  confidenceBadge: ConfidenceBadge;
}

interface ProviderRowView extends PayshCatalogProvider {
  walletScores: WalletScoreView[];
  /** Convenience: highest provider score across `walletScores`, or null. */
  topProviderScore: number | null;
}

interface ProvidersResponse {
  generatedAt: string;
  totalProviders: number;
  x402Count: number;
  mppCount: number;
  scoredCount: number;
  providers: ProviderRowView[];
}

/**
 * Map operator-id → recipient address. Only the recipient (the agent's
 * payable wallet) is what AgentKarma scores under the Provider face; the
 * fee-payer is the operator's own gas-sponsoring wallet, not the agent.
 */
function recipientForOperator(id: PayshOperatorId): string {
  return PAYSH_OPERATORS[id].recipient;
}

async function fetchScoresForOperators(
  operatorIds: PayshOperatorId[],
): Promise<Map<PayshOperatorId, WalletScoreView[]>> {
  const out = new Map<PayshOperatorId, WalletScoreView[]>();
  if (operatorIds.length === 0) return out;

  // De-dupe operators (multiple providers can share one operator).
  const unique = Array.from(new Set(operatorIds));

  const lookups: Array<[PayshOperatorId, WalletScoreView[]]> = await Promise.all(
    unique.map(async (id): Promise<[PayshOperatorId, WalletScoreView[]]> => {
      const recipient = recipientForOperator(id);
      try {
        const wallet = await getWallet(recipient);
        if (!wallet) return [id, []];
        const view: WalletScoreView = {
          address: wallet.address,
          providerScore: Number(wallet.provider_score ?? wallet.score ?? 0),
          trustTier: wallet.trust_tier,
          confidenceBadge: wallet.confidence_badge,
        };
        return [id, [view]];
      } catch {
        return [id, []];
      }
    }),
  );

  for (const [id, scores] of lookups) out.set(id, scores);
  return out;
}

export async function GET() {
  let catalog;
  try {
    catalog = await fetchPayshCatalog();
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Failed to fetch pay.sh catalog', detail: message },
      { status: 502, headers: corsHeaders() },
    );
  }

  const operatorIds = catalog.providers
    .map((p) => p.paysOperatorId)
    .filter((id): id is PayshOperatorId => id !== null);

  const scoresMap = await fetchScoresForOperators(operatorIds);

  const providers: ProviderRowView[] = catalog.providers.map((p) => {
    const walletScores = p.paysOperatorId
      ? scoresMap.get(p.paysOperatorId) ?? []
      : [];
    const topProviderScore = walletScores.length > 0
      ? Math.max(...walletScores.map((w) => w.providerScore))
      : null;
    return { ...p, walletScores, topProviderScore };
  });

  // Rank: scored providers first (by score desc), then unscored alphabetically.
  providers.sort((a, b) => {
    const aScore = a.topProviderScore;
    const bScore = b.topProviderScore;
    if (aScore != null && bScore != null) return bScore - aScore;
    if (aScore != null) return -1;
    if (bScore != null) return 1;
    return a.fqn.localeCompare(b.fqn);
  });

  const x402Count = providers.filter((p) => p.classification === 'x402').length;
  const mppCount  = providers.filter((p) => p.classification === 'mpp').length;
  const scoredCount = providers.filter((p) => p.topProviderScore != null).length;

  const body: ProvidersResponse = {
    generatedAt: catalog.generatedAt,
    totalProviders: providers.length,
    x402Count,
    mppCount,
    scoredCount,
    providers,
  };

  return NextResponse.json(body, {
    headers: {
      ...corsHeaders(),
      // 5min browser/CDN cache, with stale-while-revalidate for smooth refresh.
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
    },
  });
}

export type { ProvidersResponse, ProviderRowView, WalletScoreView };
