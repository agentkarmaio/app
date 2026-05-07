/**
 * /paysh — pay.sh provider directory overlay.
 *
 * Server component. Lists every provider in the live pay.sh skills catalog
 * (75 as of 2026-05-06), classified by protocol (x402 vs MPP-on-Solana) and
 * ranked by Provider Karma + confidence badge.
 *
 * Pure read overlay. No DB writes. We never proxy a pay.sh call — the only
 * outbound link per row points to the upstream provider page on pay.sh.
 */
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { fetchPayshCatalog, type PayshCatalogProvider } from '@/lib/paysh-catalog';
import { PAYSH_OPERATORS, type PayshOperatorId } from '@/config/paysh-operators';
import { getWallet } from '@/db/client';
import { ConfidenceBadge } from '@/components/karma/confidence-badge';
import { TierBadge } from '@/components/karma/tier-badge';
import type { ConfidenceBadge as ConfidenceBadgeValue, TrustTier } from '@/db/schema';
import { cn } from '@/lib/utils';

export const metadata = {
  title: 'pay.sh providers — ranked by AgentKarma',
  description:
    '75 APIs across x402 and MPP-on-Solana, ranked by Provider Karma. Receipt-backed, behavior-inferred, or declared — every score carries a confidence badge.',
};

// Force dynamic so we always re-evaluate against the 1h-cached catalog and
// surface fresh Karma scores from Supabase. Catalog itself is cached upstream.
export const dynamic = 'force-dynamic';

type ProtocolFilter = 'all' | 'x402' | 'mpp';

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

interface RankedProvider extends PayshCatalogProvider {
  providerScore: number | null;
  trustTier: TrustTier | null;
  confidenceBadge: ConfidenceBadgeValue | null;
}

async function loadProviders(): Promise<{
  providers: RankedProvider[];
  generatedAt: string;
}> {
  const catalog = await fetchPayshCatalog();

  // Resolve unique operator recipient addresses, fetch wallet rows in
  // parallel. Missing wallets just produce nullish scores — that's expected
  // until A2's MPP indexer is live.
  const operatorIds = Array.from(
    new Set(
      catalog.providers
        .map((p) => p.paysOperatorId)
        .filter((id): id is PayshOperatorId => id !== null),
    ),
  );

  const scoreMap = new Map<PayshOperatorId, {
    providerScore: number;
    trustTier: TrustTier;
    confidenceBadge: ConfidenceBadgeValue;
  } | null>();

  await Promise.all(
    operatorIds.map(async (id) => {
      const recipient = PAYSH_OPERATORS[id].recipient;
      try {
        const w = await getWallet(recipient);
        if (!w) return scoreMap.set(id, null);
        scoreMap.set(id, {
          providerScore: Number(w.provider_score ?? w.score ?? 0),
          trustTier: w.trust_tier,
          confidenceBadge: w.confidence_badge,
        });
      } catch {
        scoreMap.set(id, null);
      }
    }),
  );

  const ranked: RankedProvider[] = catalog.providers.map((p) => {
    const score = p.paysOperatorId ? scoreMap.get(p.paysOperatorId) ?? null : null;
    return {
      ...p,
      providerScore: score ? score.providerScore : null,
      trustTier: score ? score.trustTier : null,
      confidenceBadge: score ? score.confidenceBadge : null,
    };
  });

  ranked.sort((a, b) => {
    if (a.providerScore != null && b.providerScore != null) {
      return b.providerScore - a.providerScore;
    }
    if (a.providerScore != null) return -1;
    if (b.providerScore != null) return 1;
    return a.fqn.localeCompare(b.fqn);
  });

  return { providers: ranked, generatedAt: catalog.generatedAt };
}

function buildHref(filter: ProtocolFilter): string {
  return filter === 'all' ? '/paysh' : `/paysh?protocol=${filter}`;
}

function parseFilter(raw: string | undefined): ProtocolFilter {
  if (raw === 'x402' || raw === 'mpp') return raw;
  return 'all';
}

export default async function PayshPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const filter = parseFilter(params.protocol);

  let providers: RankedProvider[] = [];
  let generatedAt = '';
  let loadError = false;
  try {
    const data = await loadProviders();
    providers = data.providers;
    generatedAt = data.generatedAt;
  } catch {
    loadError = true;
  }

  const totalCount = providers.length;
  const x402Count  = providers.filter((p) => p.classification === 'x402').length;
  const mppCount   = providers.filter((p) => p.classification === 'mpp').length;
  const scoredCount = providers.filter((p) => p.providerScore != null).length;

  const filteredProviders = filter === 'all'
    ? providers
    : providers.filter((p) => p.classification === filter);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-[32px] font-[510] leading-tight tracking-[-0.704px] text-[#f7f8f8]">
          pay.sh providers
        </h1>
        <p className="mt-1.5 text-[15px] text-[#8a8f98] tracking-[-0.165px]">
          75 APIs across x402 and MPP-on-Solana, ranked by AgentKarma.
        </p>
        {generatedAt && (
          <p className="mt-2 text-[12px] text-[#62666d] tracking-[-0.13px]">
            Catalog generated {new Date(generatedAt).toLocaleString('en-US', {
              month: 'short', day: 'numeric', year: 'numeric',
            })} · refreshed hourly.
          </p>
        )}
      </header>

      <StatRow
        total={totalCount}
        x402={x402Count}
        mpp={mppCount}
        scored={scoredCount}
      />

      <FilterPills active={filter} x402Count={x402Count} mppCount={mppCount} totalCount={totalCount} />

      {loadError ? (
        <ErrorState />
      ) : filteredProviders.length === 0 ? (
        <EmptyState filter={filter} />
      ) : (
        <ProviderTable rows={filteredProviders} />
      )}

      <Footnote />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function StatRow({
  total, x402, mpp, scored,
}: { total: number; x402: number; mpp: number; scored: number }) {
  const items = [
    { label: 'Providers',   value: total },
    { label: 'x402',        value: x402 },
    { label: 'MPP',         value: mpp },
    { label: 'With Karma',  value: scored },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((it) => (
        <div
          key={it.label}
          className="rounded-lg border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] px-3 py-3"
        >
          <div className="text-[10px] font-[590] uppercase tracking-[0.1em] text-[#62666d]">
            {it.label}
          </div>
          <div className="mt-1 text-[22px] font-[510] tabular-nums tracking-[-0.288px] text-[#f7f8f8]">
            {it.value.toLocaleString()}
          </div>
        </div>
      ))}
    </div>
  );
}

function FilterPills({
  active, x402Count, mppCount, totalCount,
}: {
  active: ProtocolFilter;
  x402Count: number;
  mppCount: number;
  totalCount: number;
}) {
  const tabs: { key: ProtocolFilter; label: string; count: number }[] = [
    { key: 'all',  label: 'All',  count: totalCount },
    { key: 'x402', label: 'x402', count: x402Count },
    { key: 'mpp',  label: 'MPP',  count: mppCount },
  ];
  return (
    <div className="inline-flex items-center gap-0.5 rounded-full border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.02)] p-0.5">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={buildHref(t.key)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-[510] tracking-[-0.13px] transition-colors',
            active === t.key
              ? 'bg-[#5e6ad2]/14 text-[#a8b0ff] ring-1 ring-inset ring-[#5e6ad2]/30'
              : 'text-[#8a8f98] hover:text-[#f7f8f8] hover:bg-[rgb(255_255_255/0.04)]',
          )}
        >
          {t.label}
          <span className={cn(
            'tabular-nums text-[11px]',
            active === t.key ? 'text-[#a8b0ff]/80' : 'text-[#62666d]',
          )}>
            {t.count}
          </span>
        </Link>
      ))}
    </div>
  );
}

function ProtocolBadge({
  kind, confidence,
}: { kind: 'x402' | 'mpp'; confidence: 'high' | 'low' }) {
  const isMpp = kind === 'mpp';
  // Both protocols share the same achromatic chrome; only labels differ. The
  // signal weight is conveyed via Karma + confidence, not the protocol pill.
  const tone = confidence === 'low'
    ? 'bg-[rgb(255_255_255/0.03)] text-[#8a8f98] border-[rgb(255_255_255/0.06)]'
    : isMpp
      ? 'bg-[rgb(113_112_255/0.10)] text-[#a8b0ff] border-[rgb(113_112_255/0.22)]'
      : 'bg-[rgb(255_255_255/0.04)] text-[#d0d6e0] border-[rgb(255_255_255/0.08)]';
  const label = isMpp ? 'MPP' : 'x402';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-[510] tracking-[-0.13px] uppercase',
        tone,
      )}
      title={confidence === 'low'
        ? 'Classification heuristic — not yet probed against a live 402 challenge.'
        : isMpp
          ? 'MPP-on-Solana settlement via pay.sh gateway.'
          : 'Vanilla x402 settlement.'}
    >
      {label}
    </span>
  );
}

function PriceCell({ min, max }: { min: number; max: number }) {
  const fmt = (n: number) =>
    n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
  if (min === max) return <span className="tabular-nums">{fmt(min)}</span>;
  return (
    <span className="tabular-nums">
      {fmt(min)}<span className="text-[#62666d]"> – </span>{fmt(max)}
    </span>
  );
}

function ScoreCell({ score }: { score: number | null }) {
  if (score == null) {
    return (
      <span className="text-[#62666d] tabular-nums" title="No on-chain receipts indexed for this provider yet.">
        —
      </span>
    );
  }
  return (
    <span className="text-[#f7f8f8] tabular-nums font-[510]">
      {score.toFixed(0)}
    </span>
  );
}

function ProviderTable({ rows }: { rows: RankedProvider[] }) {
  return (
    <div className="rounded-lg border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] overflow-hidden">
      <div className="hidden md:grid border-b border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.015)] px-4 py-2 text-[10px] font-[590] uppercase tracking-[0.1em] text-[#62666d] grid-cols-[minmax(0,2.4fr)_64px_72px_minmax(0,1fr)_84px_140px_28px] items-center gap-3">
        <span>Provider</span>
        <span className="text-right">Endpts</span>
        <span>Protocol</span>
        <span>Pricing</span>
        <span className="text-right">Karma</span>
        <span>Confidence</span>
        <span className="sr-only">Open</span>
      </div>

      <div>
        {rows.map((r) => <ProviderRow key={r.fqn} row={r} />)}
      </div>
    </div>
  );
}

function ProviderRow({ row }: { row: RankedProvider }) {
  const externalUrl = `https://pay.sh/skills/${row.fqn}`;

  return (
    <div className="group border-b border-[rgb(255_255_255/0.04)] last:border-0 px-4 py-3 hover:bg-[rgb(255_255_255/0.025)] transition-colors text-[13px] grid grid-cols-1 md:grid-cols-[minmax(0,2.4fr)_64px_72px_minmax(0,1fr)_84px_140px_28px] gap-2 md:gap-3 items-center">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-[510] text-[#f7f8f8] truncate" title={row.name}>
            {row.name}
          </span>
          <span className="hidden sm:inline text-[10px] font-[510] uppercase tracking-[0.08em] text-[#62666d]">
            {row.category}
          </span>
        </div>
        <div className="mt-0.5 font-mono text-[11px] text-[#62666d] truncate" title={row.fqn}>
          {row.fqn}
        </div>
        <div className="md:hidden mt-2 flex flex-wrap items-center gap-2">
          <ProtocolBadge kind={row.classification} confidence={row.classificationConfidence} />
          <span className="text-[11px] text-[#8a8f98] tabular-nums">
            {row.endpointCount} endpoints
          </span>
          <span className="text-[11px] text-[#8a8f98]">
            <PriceCell min={row.pricingMin} max={row.pricingMax} />
          </span>
        </div>
      </div>

      <div className="hidden md:flex items-center justify-end text-[#d0d6e0] tabular-nums text-[12px]">
        {row.endpointCount}
      </div>

      <div className="hidden md:flex">
        <ProtocolBadge kind={row.classification} confidence={row.classificationConfidence} />
      </div>

      <div className="hidden md:flex items-center text-[12px] text-[#d0d6e0]">
        <PriceCell min={row.pricingMin} max={row.pricingMax} />
      </div>

      <div className="flex items-center justify-between md:justify-end gap-2 text-[13px]">
        <span className="md:hidden text-[10px] font-[590] uppercase tracking-[0.1em] text-[#62666d]">
          Karma
        </span>
        <div className="flex items-center gap-2">
          <ScoreCell score={row.providerScore} />
          {row.trustTier && row.trustTier !== 'Unrated' && (
            <TierBadge tier={row.trustTier} size="sm" />
          )}
        </div>
      </div>

      <div className="flex items-center">
        {row.confidenceBadge ? (
          <ConfidenceBadge badge={row.confidenceBadge} size="sm" />
        ) : (
          <span className="inline-flex items-center rounded-full border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.02)] px-2 py-0.5 text-[10px] font-[510] text-[#62666d] tracking-[-0.13px]">
            Not indexed
          </span>
        )}
      </div>

      <div className="flex items-center justify-end">
        <a
          href={externalUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${row.name} on pay.sh`}
          title={`Open ${row.name} on pay.sh`}
          className="inline-flex size-7 items-center justify-center rounded-md text-[#62666d] hover:text-[#a8b0ff] hover:bg-[rgb(255_255_255/0.04)] transition-colors"
        >
          <ExternalLink className="size-3.5" />
        </a>
      </div>
    </div>
  );
}

function EmptyState({ filter }: { filter: ProtocolFilter }) {
  return (
    <div className="rounded-lg border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] py-16 text-center">
      <p className="text-[14px] text-[#d0d6e0]">No providers match this filter.</p>
      <p className="mt-1 text-[12px] text-[#62666d]">
        {filter === 'mpp'
          ? 'MPP providers appear once the catalog refreshes.'
          : 'Try the All filter.'}
      </p>
    </div>
  );
}

function ErrorState() {
  return (
    <div className="rounded-lg border border-[rgb(245_166_35/0.2)] bg-[rgb(245_166_35/0.05)] py-12 px-6">
      <p className="text-[14px] text-[#f5a623] font-[510]">Catalog temporarily unavailable.</p>
      <p className="mt-1 text-[12px] text-[#d0d6e0]">
        We could not reach <span className="font-mono">storage.googleapis.com/pay-skills</span>.
        The directory will refresh automatically once the upstream is reachable.
      </p>
    </div>
  );
}

function Footnote() {
  return (
    <div className="text-[12px] text-[#62666d] leading-[1.6] tracking-[-0.13px] max-w-[640px]">
      <p>
        AgentKarma is a reputation primitive — we do not proxy pay.sh calls.
        Every score on this page is anchored to one of three confidence
        tiers (receipt-backed, behavior-inferred, declared) per the
        <Link
          href="/protocol"
          className="ml-1 underline-offset-2 text-[#8a8f98] hover:text-[#a8b0ff] hover:underline"
        >
          Karma Protocol
        </Link>
        {'. '}
        Outbound links open the upstream provider page on pay.sh.
      </p>
    </div>
  );
}
