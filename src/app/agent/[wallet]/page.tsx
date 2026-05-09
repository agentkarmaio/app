import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft, ExternalLink, Globe, Verified } from 'lucide-react';
import {
  getWallet,
  getTransactions,
  getTransactionCount,
  getFeedbackSummary,
  getFeedbackRatingsForSignatures,
  getScoreHistory,
  getAgentManifestsForWallet,
  getLatestSignalValues,
  getWalletScanState,
  type WalletScanInfo,
} from '@/db/client';
import { calculateScore, type WalletScore } from '@/scoring/index';
import { computeCadence } from '@/scoring/cadence';
import { computeAutonomy, type AutonomyResult } from '@/scoring/autonomy';
import { readAttestation } from '@/integrations/attestation';
import { ScoreRing } from '@/components/karma/score-ring';
import { TierBadge } from '@/components/karma/tier-badge';
import { ConfidenceBadge } from '@/components/karma/confidence-badge';
import { AutonomyChip } from '@/components/karma/autonomy-chip';
import { WalletAddress } from '@/components/karma/wallet-address';
import { MetricBar } from '@/components/karma/metric-bar';
import { TransactionList } from '@/components/karma/transaction-list';
import { LivenessIndicator } from '@/components/karma/liveness-indicator';
import { ClaimBanner } from '@/components/karma/claim-banner';
import { FeedbackSection } from '@/components/karma/feedback-section';
import { ScoreChart } from '@/components/karma/score-chart';
import { ManifestCard } from '@/components/karma/manifest-card';
import { TempoCard } from '@/components/karma/tempo-card';
import { ScanPoller } from '@/components/scan-poller';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import type { TrustTier, ConfidenceBadge as ConfidenceBadgeValue, AutonomyLabel } from '@/db/schema';

const CATEGORY_LABELS: Record<string, string> = {
  ai: 'AI / ML',
  data: 'Data Feed',
  defi: 'DeFi',
  infra: 'Infrastructure',
  social: 'Social',
  utility: 'Utility',
  other: 'Other',
};

const SITE_URL = 'https://agentkarma.io';

function shortAddr(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

/**
 * Stub shown when a wallet is queried but the indexer hasn't seen it yet.
 *
 * Per the protocol promise, "if your wallet touched the chain, you have a
 * score" — but our indexer only ingests x402 + pay.sh flows. Unknown
 * wallets used to 404; that contradicted the promise. Now we render a
 * minimal profile that acknowledges the address exists, links out to
 * Solscan, and surfaces the claim path so the operator can pull the agent
 * into the index manually.
 */
function UnindexedAgentStub({ wallet }: { wallet: string }) {
  return (
    <div className="space-y-6">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to Leaderboard
      </Link>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[24px] font-[510] tracking-[-0.288px] text-[#f7f8f8]">
            Agent profile
          </h1>
          <ConfidenceBadge badge="declared" size="sm" />
        </div>
        <div className="flex items-center gap-3">
          <WalletAddress address={wallet} truncate={false} className="text-muted-foreground" />
          <a
            href={`https://solscan.io/account/${wallet}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </a>
        </div>
      </header>

      <Separator />

      <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
            Not indexed yet
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-[13.5px] leading-relaxed text-[#b4bcd0]">
          <p>
            AgentKarma hasn&apos;t indexed any on-chain activity for this wallet.
            The indexer currently ingests x402 payments + pay.sh routed
            settlement; arbitrary wallet activity is rolled in via seeded-graph
            expansion as the wallet shows up as a counterparty of a known agent.
          </p>
          <p>
            Two ways to surface this wallet in AgentKarma:
          </p>
          <ul className="ml-4 list-disc space-y-1.5 text-[13px]">
            <li>
              Have the wallet send or receive an x402 payment (or a pay.sh
              routed settlement) — the indexer picks it up automatically on the
              next webhook tick.
            </li>
            <li>
              Claim it: prove ownership with a wallet signature, declare a
              public manifest, and the agent enters the directory immediately
              with a ⚪ <span className="font-[510] text-[#d0d6e0]">Declared</span> confidence badge.
            </li>
          </ul>
        </CardContent>
      </Card>

      <ClaimBanner walletAddress={wallet} />
    </div>
  );
}

/**
 * Stub shown when an unknown wallet has been enqueued for a regressive scan
 * and the worker either hasn't started ('pending') or is mid-scan ('scanning').
 *
 * Replaces UnindexedAgentStub for that window so the user understands why the
 * page is empty and that work is in flight. The embedded ScanPoller polls
 * /api/score/[wallet] every 5s and triggers `router.refresh()` when the route
 * flips from 202 to 200, so the page seamlessly transitions to the full
 * profile without a manual reload.
 */
function ScanningAgentStub({
  wallet,
  scanState,
}: {
  wallet: string;
  scanState: WalletScanInfo;
}) {
  const isScanning = scanState.state === 'scanning';
  const statusLine = isScanning ? 'Scanning history…' : 'Queued for scan';
  const hits = scanState.hitCount ?? 0;
  const attempts = scanState.attempts ?? 0;

  return (
    <div className="space-y-6">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to Leaderboard
      </Link>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[24px] font-[510] tracking-[-0.288px] text-[#f7f8f8]">
            Agent profile
          </h1>
          <Badge
            variant="outline"
            className="border-[rgb(94_106_210/0.25)] bg-[rgb(94_106_210/0.10)] text-[#828fff] text-[10px] px-1.5 py-0 font-[510]"
          >
            {statusLine}
          </Badge>
        </div>
        <div className="flex items-center gap-3">
          <span
            className="font-mono text-[13px] tracking-tight text-[#b4bcd0]"
            style={{ fontFamily: 'var(--font-mono, "JetBrains Mono", monospace)' }}
            title={wallet}
          >
            {shortAddr(wallet)}
          </span>
          <a
            href={`https://solscan.io/account/${wallet}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </a>
        </div>
      </header>

      <Separator />

      <Card className="border-[rgb(94_106_210/0.18)] bg-[rgb(94_106_210/0.04)]">
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
            {statusLine}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-[13.5px] leading-relaxed text-[#b4bcd0]">
          <p>
            AgentKarma is scanning this wallet&apos;s history for x402 + pay.sh
            activity. This usually completes within ~30 seconds.
          </p>
          {(hits > 0 || attempts > 1) && (
            <ul className="ml-4 list-disc space-y-1 text-[12.5px] text-[#8a8f98]">
              {hits > 0 && (
                <li>
                  Found <span className="font-[590] text-[#d0d6e0]">{hits}</span>{' '}
                  {hits === 1 ? 'receipt' : 'receipts'} so far
                </li>
              )}
              {attempts > 1 && (
                <li>
                  Retry attempt{' '}
                  <span className="font-[590] text-[#d0d6e0]">{attempts}</span>
                </li>
              )}
            </ul>
          )}
          <ScanPoller wallet={wallet} />
        </CardContent>
      </Card>
    </div>
  );
}

export async function generateMetadata(
  { params }: { params: Promise<{ wallet: string }> },
): Promise<Metadata> {
  const { wallet } = await params;
  if (!wallet || wallet.length < 32) {
    return { title: 'Agent not found' };
  }

  const row = await getWallet(wallet).catch(() => null);
  const name = row?.display_name ?? `Agent ${shortAddr(wallet)}`;
  const score = Number(row?.provider_score ?? row?.score ?? 0);
  const tier = row?.trust_tier ?? 'Unrated';
  const badge = row?.confidence_badge ?? 'declared';
  const txCount = row?.tx_count ?? 0;

  const badgeLabel = badge === 'receipt-backed'
    ? 'Receipt-backed'
    : badge === 'behavior-inferred'
      ? 'Behavior-inferred'
      : 'Declared';

  const title = `${name} — Karma ${score.toFixed(0)}/100 · ${tier}`;
  const description =
    `${name}: Provider Karma ${score.toFixed(1)}/100, trust tier ${tier}, confidence ${badgeLabel}. `
    + `${txCount.toLocaleString()} on-chain transactions indexed. `
    + `Live reputation snapshot for autonomous agent ${wallet} on Solana via AgentKarma.`;

  const canonical = `/agent/${wallet}`;
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      type: 'profile',
      url: `${SITE_URL}${canonical}`,
      title,
      description,
      siteName: 'AgentKarma',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
    },
  };
}

function CardSkeleton({ title, rows = 5 }: { title: string; rows?: number }) {
  return (
    <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
      <CardHeader className="pb-4">
        <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="h-3 rounded bg-[rgb(255_255_255/0.04)] animate-pulse"
            style={{ width: `${100 - i * 8}%` }}
          />
        ))}
      </CardContent>
    </Card>
  );
}

// Full-history live score used by every tier-bearing surface on this page so
// the ring, header badge, summary, and breakdown bars can never disagree.
// Matches what /api/score/refresh computes (cap 10000 txs, same tier gating).
async function computeLiveAgentScore(
  wallet: string,
  feedback: { deliveryRate: number; total: number },
): Promise<{
  live: WalletScore | null;
  manifestValue: number | null;
  txCount: number;
  autonomy: AutonomyResult | null;
}> {
  const [txs, attestation, manifestMap] = await Promise.all([
    getTransactions(wallet, 10000),
    readAttestation(wallet).catch(() => 0),
    getLatestSignalValues([wallet], 'manifest').catch(() => new Map<string, number>()),
  ]);
  const manifestValue = manifestMap.get(wallet) ?? null;
  if (txs.length === 0) return { live: null, manifestValue, txCount: 0, autonomy: null };
  const cadence = computeCadence(txs.map((tx) => new Date(tx.timestamp)));
  const autonomy = computeAutonomy(
    txs.map((tx) => ({ timestamp: tx.timestamp, counterparty: tx.facilitator })),
  );
  const live = calculateScore(
    txs, attestation, feedback.deliveryRate, feedback.total,
    cadence?.automationScore ?? null,
    manifestValue,
  );
  return { live, manifestValue, txCount: txs.length, autonomy };
}

function ScoreBreakdownCard({
  live,
  manifestValue,
  txCount,
}: {
  live: WalletScore | null;
  manifestValue: number | null;
  txCount: number;
}) {
  if (!live) {
    return (
      <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
        <CardHeader className="pb-4">
          <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
            Score Breakdown
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No transactions yet.</p>
        </CardContent>
      </Card>
    );
  }

  const m = live.metrics;
  const effective = live.tierAggregates;
  const tier1Pct = effective.tier1 != null ? Math.round(effective.tier1 * 100) : null;
  const tier2Pct = effective.tier2 != null ? Math.round(effective.tier2 * 100) : null;
  const tier3Pct = effective.tier3 != null ? Math.round(effective.tier3 * 100) : null;
  const manifestVerified = manifestValue != null && manifestValue >= 1.0;

  return (
    <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
      <CardHeader className="pb-4">
        <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
          Score Breakdown
        </CardTitle>
        <p className="mt-1 text-[11px] text-[#62666d]">
          Weighted blend across four signal tiers · missing tiers redistribute proportionally
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <TierSection
          label="Tier 1 · Receipts"
          weight="60%"
          dotColor="#10b981"
          summary={tier1Pct != null ? `${tier1Pct}%` : '—'}
          empty={tier1Pct == null}
          emptyHint="No receipt-backed attestations yet"
        >
          <MetricBar
            label="8004 + consumer feedback"
            value={m.attestation ?? 0}
            maxLabel="Payment + signed delivery feedback"
          />
        </TierSection>

        <TierSection
          label="Tier 2 · Behavior"
          weight="25%"
          dotColor="#f5a623"
          summary={tier2Pct != null ? `${tier2Pct}%` : '—'}
        >
          <MetricBar label="Success Rate" value={m.successRate} weight="35%" />
          <MetricBar label="Counterparty Diversity" value={m.diversity} weight="25%" maxLabel="Unique facilitators / 10" />
          <MetricBar label="Volume" value={m.volume} weight="20%" maxLabel="Transactions / 500" />
          <MetricBar label="Account Age" value={m.age} weight="20%" maxLabel="Days active / 180" />
          <MetricBar
            label="Cadence (automation)"
            value={m.cadence ?? 0}
            weight="+10% blend"
            maxLabel={
              m.cadence == null
                ? `Needs ≥10 tx to classify (have ${txCount})`
                : 'Higher = 24/7 regular pattern; lower = human-shaped'
            }
          />
        </TierSection>

        <TierSection
          label="Tier 3 · Declared identity"
          weight="10%"
          dotColor="#8a92ff"
          summary={tier3Pct != null ? `${tier3Pct}%` : '—'}
          empty={tier3Pct == null}
          emptyHint="No manifest or ownership proof yet"
        >
          <MetricBar
            label={manifestVerified ? 'Manifest (owner-signed)' : 'Manifest (declared)'}
            value={manifestValue ?? 0}
            maxLabel={
              manifestVerified
                ? 'agentkarma.json declares this wallet — owner-verified'
                : 'agentkarma.json found — wallet binding unverified'
            }
          />
        </TierSection>

        <TierSection
          label="Tier 4 · Social"
          weight="5%"
          dotColor="#8a8f98"
          summary="—"
          empty
          emptyHint="Derivative signals — deferred"
        />
      </CardContent>
    </Card>
  );
}

function TierSection({
  label,
  weight,
  dotColor,
  summary,
  empty,
  emptyHint,
  children,
}: {
  label: string;
  weight: string;
  dotColor: string;
  summary: string;
  empty?: boolean;
  emptyHint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="size-1.5 rounded-full"
            style={{ background: dotColor }}
          />
          <span className="text-[12px] font-[590] uppercase tracking-[0.08em] text-[#d0d6e0]">
            {label}
          </span>
          <span className="text-[10px] font-[510] text-[#62666d]">{weight}</span>
        </div>
        <span className="text-[12px] font-[590] tabular-nums text-[#f7f8f8]">
          {summary}
        </span>
      </div>
      {empty ? (
        <p className="text-[11px] text-[#62666d] italic">{emptyHint}</p>
      ) : (
        <div className="space-y-3 pl-3.5">{children}</div>
      )}
    </div>
  );
}

async function ScoreTrendCard({ wallet, tier }: { wallet: string; tier: TrustTier }) {
  const scoreHistory = await getScoreHistory(wallet, 30).catch(() => []);
  return (
    <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
      <CardHeader className="pb-3">
        <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
          Score Trend
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ScoreChart data={scoreHistory} tier={tier} />
      </CardContent>
    </Card>
  );
}

async function TransactionsCard({ wallet }: { wallet: string }) {
  const [transactions, txTotal] = await Promise.all([
    getTransactions(wallet, 25),
    getTransactionCount(wallet),
  ]);
  const feedbackMap = await getFeedbackRatingsForSignatures(
    transactions.map((tx) => tx.tx_signature),
  );
  return (
    <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
      <CardHeader className="pb-3">
        <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
          Recent Transactions
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <TransactionList
          walletAddress={wallet}
          total={txTotal}
          pageSize={25}
          transactions={transactions.map((tx) => ({
            id: tx.id,
            facilitator: tx.facilitator,
            amount: Number(tx.amount),
            timestamp: tx.timestamp,
            success: tx.success,
            tx_signature: tx.tx_signature,
            feedback: feedbackMap.get(tx.tx_signature) ?? null,
          }))}
        />
      </CardContent>
    </Card>
  );
}

export default async function AgentProfilePage({
  params,
}: {
  params: Promise<{ wallet: string }>;
}) {
  const { wallet } = await params;
  if (!wallet || wallet.length < 32) notFound();

  let walletRow;
  let feedbackSummary = { total: 0, delivered: 0, failed: 0, deliveryRate: 0 };

  let manifests: Awaited<ReturnType<typeof getAgentManifestsForWallet>> = [];
  try {
    [walletRow, feedbackSummary, manifests] = await Promise.all([
      getWallet(wallet),
      getFeedbackSummary(wallet).catch(() => feedbackSummary),
      getAgentManifestsForWallet(wallet).catch(() => []),
    ]);
  } catch {
    notFound();
  }

  // Show the live "Scanning history…" stub when a regressive scan is in
  // flight. Note enqueueWalletScan upserts a stub wallet row when state goes
  // to 'pending', so walletRow is non-null during a scan — the gate is
  // tx_count + scan_state, not walletRow presence.
  const txCountForGate = walletRow?.tx_count ?? await getTransactionCount(wallet).catch(() => 0);
  if (txCountForGate === 0) {
    const scanState = await getWalletScanState(wallet).catch(() => null);
    if (scanState && (scanState.state === 'pending' || scanState.state === 'scanning')) {
      return <ScanningAgentStub wallet={wallet} scanState={scanState} />;
    }
    if (!walletRow) return <UnindexedAgentStub wallet={wallet} />;
  }

  // Single source of truth for this page: recompute the score from current
  // transactions, attestations, and signals. walletRow is only used for
  // identity + timestamps; never for tier labels (they drift when DB isn't
  // backfilled after a scoring change).
  const { live, manifestValue, txCount: liveTxCount, autonomy } = await computeLiveAgentScore(wallet, feedbackSummary);

  const score = live?.score ?? Number(walletRow?.score ?? 0);
  const tier: TrustTier = live?.trustTier ?? (walletRow?.trust_tier ?? 'Unrated') as TrustTier;
  const txCount = liveTxCount || (walletRow?.tx_count ?? 0);
  const providerScore = live?.providerScore
    ?? (walletRow?.provider_score != null ? Number(walletRow.provider_score) : score);
  const consumerScore = live?.consumerScore
    ?? (walletRow?.consumer_score != null ? Number(walletRow.consumer_score) : null);
  const confidenceBadge: ConfidenceBadgeValue =
    live?.confidenceBadge ?? walletRow?.confidence_badge ?? 'declared';
  // Prefer live compute; fall back to persisted columns for wallets below the
  // MIN_TX_FOR_AUTONOMY threshold or when rows pre-date the backfill.
  const autonomyScore = autonomy?.score
    ?? (walletRow?.autonomy_score != null ? Number(walletRow.autonomy_score) : null);
  const autonomyLabel: AutonomyLabel | null = (autonomy?.label
    ?? (walletRow?.autonomy_label ?? null)) as AutonomyLabel | null;

  const isClaimed = walletRow?.claimed ?? false;
  const displayName = walletRow?.display_name;
  const agentDescription = walletRow?.description;
  const agentWebsite = walletRow?.website;
  const agentCategory = walletRow?.category;
  const agentTempoAddress = walletRow?.tempo_address;

  const agentLd = {
    '@context': 'https://schema.org',
    '@type': 'Thing',
    name: displayName ?? `Agent ${shortAddr(wallet)}`,
    identifier: wallet,
    url: `${SITE_URL}/agent/${wallet}`,
    description:
      agentDescription
      ?? `Autonomous on-chain agent on Solana. Provider Karma ${providerScore.toFixed(1)}/100, trust tier ${tier}, confidence ${confidenceBadge}.`,
    sameAs: [
      `https://solscan.io/account/${wallet}`,
      ...(agentWebsite ? [agentWebsite] : []),
    ],
    additionalProperty: [
      { '@type': 'PropertyValue', name: 'Provider Karma', value: Number(providerScore.toFixed(1)), maxValue: 100 },
      ...(consumerScore != null
        ? [{ '@type': 'PropertyValue', name: 'Consumer Karma', value: Number(consumerScore.toFixed(1)), maxValue: 100 }]
        : []),
      { '@type': 'PropertyValue', name: 'Trust Tier', value: tier },
      { '@type': 'PropertyValue', name: 'Confidence Badge', value: confidenceBadge },
      ...(autonomyScore != null && autonomyLabel
        ? [{ '@type': 'PropertyValue', name: 'Autonomy Confidence', value: Math.round(autonomyScore), unitText: autonomyLabel }]
        : []),
      { '@type': 'PropertyValue', name: 'Transactions Indexed', value: txCount },
    ],
  };

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'AgentKarma', item: SITE_URL },
      { '@type': 'ListItem', position: 2, name: 'Agents', item: `${SITE_URL}/explore` },
      { '@type': 'ListItem', position: 3, name: displayName ?? shortAddr(wallet), item: `${SITE_URL}/agent/${wallet}` },
    ],
  };

  return (
    <div className="space-y-6">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: structured-data emission
        dangerouslySetInnerHTML={{ __html: JSON.stringify(agentLd) }}
      />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: structured-data emission
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }}
      />
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" />
        Back to Leaderboard
      </Link>

      <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            {displayName ? (
              <h1 className="text-[24px] font-[510] tracking-[-0.288px] text-[#f7f8f8]">
                {displayName}
              </h1>
            ) : (
              <h1 className="text-[24px] font-[510] tracking-[-0.288px] text-[#f7f8f8]">
                Agent Profile
              </h1>
            )}
            <TierBadge tier={tier} />
            <ConfidenceBadge badge={confidenceBadge} size="sm" />
            <AutonomyChip score={autonomyScore} label={autonomyLabel} size="sm" />
            {isClaimed && (
              <Badge variant="outline" className="bg-[rgb(94_106_210/0.08)] text-[#828fff] border-[rgb(94_106_210/0.15)] text-[10px] px-1.5 py-0 font-[510]">
                <Verified className="size-3 mr-0.5" />
                Claimed
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3">
            <WalletAddress address={wallet} truncate={false} className="text-muted-foreground" />
            <a
              href={`https://solscan.io/account/${wallet}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3.5" />
            </a>
            {walletRow?.last_seen && (
              <LivenessIndicator lastSeen={walletRow.last_seen} size="sm" />
            )}
          </div>
          {agentDescription && (
            <p className="text-[14px] text-[#8a8f98] leading-relaxed max-w-lg">
              {agentDescription}
            </p>
          )}
          <div className="flex items-center gap-3">
            {agentCategory && (
              <Badge variant="outline" className="bg-[rgb(255_255_255/0.04)] text-[#8a8f98] border-[rgb(255_255_255/0.08)] text-[11px] px-1.5 py-0">
                {CATEGORY_LABELS[agentCategory] ?? agentCategory}
              </Badge>
            )}
            {agentWebsite && (
              <a
                href={agentWebsite}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[12px] text-[#8a8f98] hover:text-[#f7f8f8] transition-colors"
              >
                <Globe className="size-3" />
                {new URL(agentWebsite).hostname}
              </a>
            )}
          </div>
        </div>
        <ScoreRing score={score} tier={tier} size={90} strokeWidth={7} />
      </div>

      <Separator />

      {!isClaimed && <ClaimBanner walletAddress={wallet} />}

      <div className="grid gap-6 md:grid-cols-2">
        <ScoreBreakdownCard live={live} manifestValue={manifestValue} txCount={txCount} />

        <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
          <CardHeader className="pb-4">
            <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Provider Karma</dt>
                <dd className="font-bold tabular-nums">{providerScore.toFixed(1)} / 100</dd>
              </div>
              <Separator />
              <div className="flex justify-between">
                <dt className="text-muted-foreground" title="Will this wallet pay cleanly when it takes work? Populated in Phase I.">Consumer Karma</dt>
                <dd className="font-bold tabular-nums text-muted-foreground">
                  {consumerScore != null ? `${consumerScore.toFixed(1)} / 100` : '—'}
                </dd>
              </div>
              <Separator />
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Confidence</dt>
                <dd><ConfidenceBadge badge={confidenceBadge} size="sm" /></dd>
              </div>
              <Separator />
              <div className="flex justify-between">
                <dt className="text-muted-foreground" title="Behavioral fingerprint indicating autonomous-agent vs human operation. Orthogonal to karma (RFC v0.3 §5.5).">Autonomy</dt>
                <dd>
                  {autonomyScore != null && autonomyLabel ? (
                    <AutonomyChip score={autonomyScore} label={autonomyLabel} size="sm" />
                  ) : (
                    <span className="text-muted-foreground text-xs">—</span>
                  )}
                </dd>
              </div>
              <Separator />
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Trust Tier</dt>
                <dd><TierBadge tier={tier} size="sm" /></dd>
              </div>
              <Separator />
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Status</dt>
                <dd>
                  {walletRow?.last_seen
                    ? <LivenessIndicator lastSeen={walletRow.last_seen} size="sm" />
                    : <span className="text-muted-foreground">Unknown</span>
                  }
                </dd>
              </div>
              <Separator />
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Transactions</dt>
                <dd className="tabular-nums">{txCount.toLocaleString()}</dd>
              </div>
              <Separator />
              <div className="flex justify-between">
                <dt className="text-muted-foreground">First Seen</dt>
                <dd className="text-muted-foreground">
                  {walletRow?.first_seen
                    ? new Date(walletRow.first_seen).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                    : '—'}
                </dd>
              </div>
              <Separator />
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Last Active</dt>
                <dd className="text-muted-foreground">
                  {walletRow?.last_seen
                    ? new Date(walletRow.last_seen).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                    : '—'}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </div>

      {manifests.length > 0 && <ManifestCard manifest={manifests[0]} />}

      {agentTempoAddress && <TempoCard tempoAddress={agentTempoAddress} />}

      <Suspense fallback={<CardSkeleton title="Score Trend" rows={3} />}>
        <ScoreTrendCard wallet={wallet} tier={tier} />
      </Suspense>

      <FeedbackSection
        agentWallet={wallet}
        feedbackSummary={feedbackSummary}
      />

      <Suspense fallback={<CardSkeleton title="Recent Transactions" rows={6} />}>
        <TransactionsCard wallet={wallet} />
      </Suspense>
    </div>
  );
}
