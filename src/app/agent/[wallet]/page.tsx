import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ExternalLink, Globe, Verified } from 'lucide-react';
import {
  getWallet,
  getTransactions,
  getTransactionCount,
  getFeedbackSummary,
  getScoreHistory,
} from '@/db/client';
import { calculateScore } from '@/scoring/index';
import { readAttestation } from '@/integrations/attestation';
import { ScoreRing } from '@/components/karma/score-ring';
import { TierBadge } from '@/components/karma/tier-badge';
import { WalletAddress } from '@/components/karma/wallet-address';
import { MetricBar } from '@/components/karma/metric-bar';
import { TransactionList } from '@/components/karma/transaction-list';
import { LivenessIndicator } from '@/components/karma/liveness-indicator';
import { ClaimBanner } from '@/components/karma/claim-banner';
import { FeedbackSection } from '@/components/karma/feedback-section';
import { ScoreChart } from '@/components/karma/score-chart';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import type { TrustTier } from '@/db/schema';

const CATEGORY_LABELS: Record<string, string> = {
  ai: 'AI / ML',
  data: 'Data Feed',
  defi: 'DeFi',
  infra: 'Infrastructure',
  social: 'Social',
  utility: 'Utility',
  other: 'Other',
};

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

async function ScoreBreakdownCard({
  wallet,
  feedbackDeliveryRate,
  feedbackCount,
}: {
  wallet: string;
  feedbackDeliveryRate: number;
  feedbackCount: number;
}) {
  const [txs, attestation] = await Promise.all([
    getTransactions(wallet, 100),
    readAttestation(wallet).catch(() => 0),
  ]);

  if (txs.length === 0) {
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

  const live = calculateScore(txs, attestation, feedbackDeliveryRate, feedbackCount);
  const m = live.metrics;

  return (
    <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
      <CardHeader className="pb-4">
        <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
          Score Breakdown
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <MetricBar label="Success Rate" value={m.successRate} weight="35%" />
        <MetricBar label="Facilitator Diversity" value={m.diversity} weight="25%" maxLabel="Unique facilitators / 10" />
        <MetricBar label="Volume" value={m.volume} weight="20%" maxLabel="Transactions / 500" />
        <MetricBar label="Account Age" value={m.age} weight="10%" maxLabel="Days active / 180" />
        <MetricBar label="8004 Attestation" value={m.attestation ?? 0} weight="10%" maxLabel="On-chain feedback via 8004 protocol" />
      </CardContent>
    </Card>
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

  try {
    [walletRow, feedbackSummary] = await Promise.all([
      getWallet(wallet),
      getFeedbackSummary(wallet).catch(() => feedbackSummary),
    ]);
  } catch {
    notFound();
  }

  if (!walletRow) {
    const anyTx = await getTransactionCount(wallet).catch(() => 0);
    if (anyTx === 0) notFound();
  }

  const score = Number(walletRow?.score ?? 0);
  const tier = (walletRow?.trust_tier ?? 'Unrated') as TrustTier;
  const txCount = walletRow?.tx_count ?? 0;

  const isClaimed = walletRow?.claimed ?? false;
  const displayName = walletRow?.display_name;
  const agentDescription = walletRow?.description;
  const agentWebsite = walletRow?.website;
  const agentCategory = walletRow?.category;

  return (
    <div className="space-y-6">
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
        <Suspense fallback={<CardSkeleton title="Score Breakdown" rows={5} />}>
          <ScoreBreakdownCard
            wallet={wallet}
            feedbackDeliveryRate={feedbackSummary.deliveryRate}
            feedbackCount={feedbackSummary.total}
          />
        </Suspense>

        <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
          <CardHeader className="pb-4">
            <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Karma Score</dt>
                <dd className="font-bold tabular-nums">{score.toFixed(1)} / 100</dd>
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
                    : '\u2014'}
                </dd>
              </div>
              <Separator />
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Last Active</dt>
                <dd className="text-muted-foreground">
                  {walletRow?.last_seen
                    ? new Date(walletRow.last_seen).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                    : '\u2014'}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </div>

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
