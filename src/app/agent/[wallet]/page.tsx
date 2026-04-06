import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { getWallet, getTransactions } from '@/db/client';
import { calculateScore } from '@/scoring/index';
import { readAttestation } from '@/integrations/attestation';
import { ScoreRing } from '@/components/karma/score-ring';
import { TierBadge } from '@/components/karma/tier-badge';
import { WalletAddress } from '@/components/karma/wallet-address';
import { MetricBar } from '@/components/karma/metric-bar';
import { TransactionList } from '@/components/karma/transaction-list';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import type { TrustTier } from '@/db/schema';

export default async function AgentProfilePage({
  params,
}: {
  params: Promise<{ wallet: string }>;
}) {
  const { wallet } = await params;
  if (!wallet || wallet.length < 32) notFound();

  let walletRow;
  let transactions;

  try {
    [walletRow, transactions] = await Promise.all([
      getWallet(wallet),
      getTransactions(wallet, 100),
    ]);
  } catch {
    notFound();
  }

  if (!walletRow && transactions.length === 0) notFound();

  let attestation = 0;
  try { attestation = await readAttestation(wallet); } catch { /* no on-chain feedback */ }

  const liveScore = transactions.length > 0
    ? calculateScore(transactions, attestation)
    : null;

  const score = liveScore?.score ?? Number(walletRow?.score ?? 0);
  const tier = (liveScore?.trustTier ?? walletRow?.trust_tier ?? 'Unrated') as TrustTier;
  const metrics = liveScore?.metrics ?? { successRate: 0, diversity: 0, volume: 0, age: 0, attestation: 0 };
  const txCount = liveScore?.txCount ?? walletRow?.tx_count ?? 0;

  return (
    <div className="space-y-6">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" />
        Back to Leaderboard
      </Link>

      <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <h1 className="text-[24px] font-[510] tracking-[-0.288px] text-[#f7f8f8]">Agent Profile</h1>
            <TierBadge tier={tier} />
          </div>
          <div className="flex items-center gap-2">
            <WalletAddress address={wallet} truncate={false} className="text-muted-foreground" />
            <a
              href={`https://solscan.io/account/${wallet}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3.5" />
            </a>
          </div>
        </div>
        <ScoreRing score={score} tier={tier} size={90} strokeWidth={7} />
      </div>

      <Separator />

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
          <CardHeader className="pb-4">
            <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">Score Breakdown</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <MetricBar label="Success Rate" value={metrics.successRate} weight="35%" />
            <MetricBar label="Facilitator Diversity" value={metrics.diversity} weight="25%" maxLabel="Unique facilitators / 10" />
            <MetricBar label="Volume" value={metrics.volume} weight="20%" maxLabel="Transactions / 500" />
            <MetricBar label="Account Age" value={metrics.age} weight="10%" maxLabel="Days active / 180" />
            <MetricBar label="8004 Attestation" value={metrics.attestation ?? 0} weight="10%" maxLabel="On-chain feedback via 8004 protocol" />
          </CardContent>
        </Card>

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

      <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">Recent Transactions</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <TransactionList
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
    </div>
  );
}
