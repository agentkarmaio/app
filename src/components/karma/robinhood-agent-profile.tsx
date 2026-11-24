/**
 * Robinhood Chain profile — registry-only. Identity, registration and feedback
 * come from the hourly registry-scan mirror (erc8004_agents + erc8004_feedback),
 * never a live RPC. Provider Karma is the declared metadata score; Consumer
 * Karma is not measured because no payment source is indexed on this chain.
 * Read-only: no claim, edit or give-feedback flows.
 */
import { Suspense, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { getCachedEvmAgentOnchain } from '@/db/cached';
import { resolveRaters, getFeedbackComments, type RaterInfo } from '@/db/client';
import type { Wallet, TrustTier, ConfidenceBadge as ConfidenceBadgeValue } from '@/db/schema';
import { registryExplorerLink } from '@/lib/chain-meta';
import { scoreMetadataQuality, METADATA_SCHEME_VERSION } from '@/scoring/celo-metadata';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { AgentProfileShell } from './agent-profile-shell';
import { CardSkeleton } from './card-skeleton';
import { ChainBadge } from './chain-badge';
import { ConfidenceBadge } from './confidence-badge';
import { FeedbackRecordsCard } from './feedback-records-card';
import { ScoreRing } from './score-ring';
import { TierBadge } from './tier-badge';

const CARD = 'border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]';
const CARD_TITLE = 'text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]';

export function RobinhoodAgentProfile({
  wallet,
  walletRow,
  agentId,
  deadMansSwitch,
}: {
  wallet: string;
  /** Synthesized from the mirror row: robinhood agents have no `wallets` row. */
  walletRow: Wallet;
  agentId: number;
  deadMansSwitch?: ReactNode;
}) {
  const score = Number(walletRow.provider_score ?? walletRow.score ?? 0);
  const tier = (walletRow.trust_tier ?? 'Unrated') as TrustTier;
  const badge: ConfidenceBadgeValue = walletRow.confidence_badge ?? 'declared';
  return (
    <AgentProfileShell
      back={{ href: '/robinhood', label: 'Robinhood Chain agents' }}
      address={wallet}
      chain="robinhood"
      avatarSrc={walletRow.image_url}
      name={walletRow.display_name ?? `Agent #${agentId}`}
      description={walletRow.description}
      chips={<>
        <TierBadge tier={tier} />
        <ConfidenceBadge badge={badge} size="sm" />
        <ChainBadge chain="robinhood" />
      </>}
      score={<ScoreRing score={score} tier={tier} size={90} strokeWidth={7} />}
    >
      <Suspense fallback={<div className="grid gap-6 md:grid-cols-2">
        <CardSkeleton title="ERC-8004 identity" rows={5} />
        <CardSkeleton title="Summary" rows={5} />
      </div>}>
        <RegistrySections wallet={wallet} agentId={agentId} score={score} tier={tier} badge={badge} />
      </Suspense>
      {deadMansSwitch}
    </AgentProfileShell>
  );
}

async function RegistrySections({ wallet, agentId, score, tier, badge }: {
  wallet: string; agentId: number; score: number; tier: TrustTier; badge: ConfidenceBadgeValue;
}) {
  const { agent, feedback } = await getCachedEvmAgentOnchain('robinhood', agentId);
  const clients = feedback?.records.map((r) => r.client) ?? [];
  const [raters, comments] = await Promise.all([
    clients.length
      ? resolveRaters(clients, 'robinhood').catch(() => new Map<string, RaterInfo>())
      : new Map<string, RaterInfo>(),
    clients.length
      ? getFeedbackComments('robinhood', agentId).catch(() => new Map<string, { comment: string; verified: boolean }>())
      : new Map<string, { comment: string; verified: boolean }>(),
  ]);
  const distinctRaters = new Set(clients.map((c) => c.toLowerCase())).size;
  const services = agent?.registration?.services ?? [];
  const metadataAssessment = agent?.registration
    ? { result: scoreMetadataQuality(agent), schemeVersion: METADATA_SCHEME_VERSION }
    : null;
  const explorer = registryExplorerLink('robinhood', agentId);

  return <>
    <div className="grid gap-6 md:grid-cols-2">
      <Card className={CARD}>
        <CardHeader className="pb-4">
          <CardTitle className={CARD_TITLE}>ERC-8004 identity</CardTitle>
          <p className="mt-1 text-[11px] text-[#62666d]">Mirrored from the Robinhood Chain IdentityRegistry, refreshed hourly</p>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Row label="agentId" value={<span className="font-mono">{agentId}</span>} />
          <Separator />
          <Row label="Owner" value={<span className="font-mono text-[12px] break-all">{agent?.owner ?? wallet}</span>} />
          <Separator />
          <Row label="agentURI" value={agent?.tokenURI
            ? <span className="break-all text-[12px] text-muted-foreground">{agent.tokenURI.length > 60 ? `${agent.tokenURI.slice(0, 60)}…` : agent.tokenURI}</span>
            : <span className="text-muted-foreground">—</span>} />
          <Separator />
          <Row label="Profile" value={explorer
            ? <a href={explorer.url} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[#828fff] hover:underline underline-offset-2">
                {explorer.label}<ExternalLink className="size-3" />
              </a>
            : <span className="text-muted-foreground">—</span>} />
        </CardContent>
      </Card>

      <Card className={CARD}>
        <CardHeader className="pb-4"><CardTitle className={CARD_TITLE}>Summary</CardTitle></CardHeader>
        <CardContent>
          <dl className="space-y-3 text-sm">
            <Row label="Provider Karma" value={<span className="font-bold tabular-nums">{score.toFixed(1)} / 100</span>} />
            <Separator />
            <Row label="Consumer Karma" value={<span className="text-muted-foreground">Not measured: no payments are indexed on this chain</span>} />
            <Separator />
            <Row label="Trust Tier" value={<TierBadge tier={tier} size="sm" />} />
            <Separator />
            <Row label="Confidence" value={<ConfidenceBadge badge={badge} size="sm" />} />
            <Separator />
            <Row label="Feedback (mirrored)" value={feedback
              ? <span className="tabular-nums">
                  {feedback.count} {feedback.count === 1 ? 'record' : 'records'}
                  {feedback.count > 0 && <span className="text-muted-foreground"> from {distinctRaters} {distinctRaters === 1 ? 'rater' : 'raters'}</span>}
                </span>
              : <span className="text-muted-foreground">—</span>} />
          </dl>
          <p className="mt-4 text-[11.5px] leading-relaxed text-[#62666d]">
            Feedback is shown, not scored. The score comes from the agent&apos;s declared registration.
          </p>
        </CardContent>
      </Card>
    </div>

    {feedback && feedback.records.length > 0 && (
      <FeedbackRecordsCard records={feedback.records} raters={raters} comments={comments}
        chain="robinhood" metadataAssessment={metadataAssessment} />
    )}

    {services.length > 0 && (
      <Card className={CARD}>
        <CardHeader className="pb-3">
          <CardTitle className={CARD_TITLE}>Declared services</CardTitle>
          <p className="mt-1 text-[11px] text-[#62666d]">
            From the agent&apos;s registration JSON. AgentKarma does not proxy these endpoints; we link, we do not relay.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {services.map((s, idx) => (
            <div key={`${s.endpoint}-${idx}`} className="flex items-center justify-between rounded-md border border-border bg-card/40 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-[510] text-[#f7f8f8]">{s.name}</div>
                <div className="truncate font-mono text-[11.5px] text-muted-foreground">{s.endpoint}</div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    )}
  </>;
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{value}</dd>
    </div>
  );
}
