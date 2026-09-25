/**
 * ArcMainnetAgentProfile — /agent/[wallet]?chain=arc-mainnet.
 *
 * Same shape as the Solana profile: identity header + score ring, score
 * breakdown next to a summary, then evidence. Karma comes from observed USDC
 * transfers (resolveKarma); when the address resolves to an ERC-8004 agentId the
 * profile also streams the ReputationRegistry records (AK attestations + third-
 * party reviews) and the give-feedback form, exactly like the Celo profile.
 *
 * No claim / edit / prove surface: mainnet ownership changes are disabled
 * server-side (501), so offering them here would only produce errors.
 */
import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { resolveKarma, type KarmaFaceBlock } from '@/lib/karma-resolver';
import { collectArcMainnetReceipts } from '@/scoring/arc-mainnet-receipts';
import {
  getSignalEventsForWallet,
  getErc8004Agent,
  resolveRaters,
  getFeedbackComments,
  type RaterInfo,
} from '@/db/client';
import { getCachedEvmAgentOnchain } from '@/db/cached';
import { getAdapter } from '@/chain-adapters/registry';
import { formatUsdcAmount } from '@/lib/format';
import { safeHref } from '@/lib/safe-url';
import { scoreMetadataQuality, METADATA_SCHEME_VERSION } from '@/scoring/celo-metadata';
import { IDENTITY_REGISTRY_ARC_MAINNET } from '@/integrations/erc8004-arc-mainnet';
import type { TrustTier } from '@/db/schema';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { ConfidenceBadge } from './confidence-badge';
import { NotIndexedBlock } from './not-indexed-block';
import { AutonomyChip } from './autonomy-chip';
import { AgentAvatar } from './agent-avatar';
import { ScoreRing } from './score-ring';
import { TierBadge } from './tier-badge';
import { ChainBadge } from './chain-badge';
import { WalletAddress } from './wallet-address';
import { BadgeButton } from './badge-button';
import { MetricBar } from './metric-bar';
import { LivenessIndicator } from './liveness-indicator';
import { CardSkeleton } from './card-skeleton';
import { FeedbackRecordsCard } from './feedback-records-card';
import { GiveFeedbackCard } from './give-feedback-card';

const CARD = 'border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]';
const CARD_TITLE = 'text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]';

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmtDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
}

function faceScore(face: KarmaFaceBlock): string {
  return face.hasSignal && Number.isFinite(face.score) ? `${face.score.toFixed(1)} / 100` : 'Unrated';
}

export async function ArcMainnetAgentProfile({
  wallet,
  agentId,
  deadMansSwitch,
}: {
  wallet: string;
  agentId?: number | null;
  /** Observe-only Succession + Bonding grid, loaded chain-aware in the page. */
  deadMansSwitch?: React.ReactNode;
}) {
  const snapshot = await resolveKarma(wallet, 'arc-mainnet', { agentId });
  if (agentId != null && !snapshot) notFound();
  const evidenceAddress = snapshot?.address ?? wallet;
  // An address lookup can also resolve the registry identity (payment wallet ==
  // agentWallet); feedback needs the agentId either way.
  const registryAgentId = snapshot?.agentId ?? null;
  const [events, registryRow] = await Promise.all([
    getSignalEventsForWallet(evidenceAddress, 50, 'arc-mainnet'),
    registryAgentId != null ? getErc8004Agent('arc-mainnet', registryAgentId).catch(() => null) : null,
  ]);
  const receipts = collectArcMainnetReceipts(evidenceAddress, events).observations
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.logIndex - a.logIndex);
  const adapter = getAdapter('arc-mainnet');

  const registration = (registryRow?.registration ?? null) as { image?: string } | null;
  const displayName = snapshot?.identity.displayName ?? `Agent ${shortAddr(evidenceAddress)}`;
  const provider = snapshot?.provider;
  const score = provider?.hasSignal && Number.isFinite(provider.score) ? provider.score : 0;
  const tier = (provider?.trustTier ?? 'Unrated') as TrustTier;
  const website = safeHref(snapshot?.identity.website);

  return (
    <div className="space-y-6">
      <Link
        href="/arc/mainnet"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Arc mainnet coverage
      </Link>

      <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <AgentAvatar src={registration?.image ?? null} name={displayName} />
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-[24px] font-[510] tracking-[-0.288px] text-[#f7f8f8]">{displayName}</h1>
              <TierBadge tier={tier} />
              <ConfidenceBadge badge={snapshot?.confidenceBadge ?? 'declared'} size="sm" />
              <ChainBadge chain="arc-mainnet" variant="label" />
              {snapshot?.autonomy.score != null && snapshot.autonomy.label && (
                <AutonomyChip score={snapshot.autonomy.score} label={snapshot.autonomy.label} size="sm" />
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              Arc mainnet{registryAgentId != null ? ` · Agent #${registryAgentId}` : ''}
            </p>
            <div className="flex items-center gap-3">
              <WalletAddress address={evidenceAddress} truncate={false} className="text-muted-foreground" />
              <a
                href={adapter.explorerAddressUrl(evidenceAddress)}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="View on Arc explorer"
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                <ExternalLink className="size-3.5" />
              </a>
              {snapshot && <BadgeButton wallet={evidenceAddress} chain="arc-mainnet" />}
            </div>
            {snapshot?.identity.description && (
              <p className="max-w-lg text-[14px] leading-relaxed text-[#8a8f98]">{snapshot.identity.description}</p>
            )}
            {website && (
              <a
                href={website}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[12px] text-[#8a8f98] transition-colors hover:text-[#f7f8f8]"
              >
                <ExternalLink className="size-3" />
                {website}
              </a>
            )}
          </div>
        </div>
        {snapshot && <ScoreRing score={score} tier={tier} size={90} strokeWidth={7} />}
      </div>

      <Separator />

      {!snapshot ? <NotIndexedBlock chain="arc-mainnet" /> : (
        <div className="grid gap-6 md:grid-cols-2">
          <Card className={CARD}>
            <CardHeader className="pb-4">
              <CardTitle className={CARD_TITLE}>Score Breakdown</CardTitle>
              <p className="mt-1 text-[11px] text-[#62666d]">
                Observed USDC transfers · incoming feed Provider, outgoing feed Consumer
              </p>
            </CardHeader>
            <CardContent className="space-y-6">
              {[snapshot.provider, snapshot.consumer].map(face => (
                <FaceBreakdown key={face.face} face={face} />
              ))}
              <p className="text-[11px] text-[#62666d]">
                Transfer activity does not verify service delivery. Reciprocal transfers are discounted within the observed window.
                {snapshot.receiptEvidence?.saturated ? ' The history limit was reached; older activity is outside this score.' : ''}
              </p>
            </CardContent>
          </Card>

          <Card className={CARD}>
            <CardHeader className="pb-4">
              <CardTitle className={CARD_TITLE}>Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-3 text-sm">
                <Row label="Provider Karma" value={<span className="font-bold tabular-nums">{faceScore(snapshot.provider)}</span>} />
                <Separator />
                <Row label="Consumer Karma" value={<span className="font-bold tabular-nums text-muted-foreground">{faceScore(snapshot.consumer)}</span>} />
                <Separator />
                <Row label="Confidence" value={<ConfidenceBadge badge={snapshot.confidenceBadge} size="sm" />} />
                <Separator />
                <Row
                  label="Autonomy"
                  value={snapshot.autonomy.score != null && snapshot.autonomy.label
                    ? <AutonomyChip score={snapshot.autonomy.score} label={snapshot.autonomy.label} size="sm" />
                    : <span className="text-xs text-muted-foreground">—</span>}
                />
                <Separator />
                <Row label="Trust Tier" value={<TierBadge tier={tier} size="sm" />} />
                <Separator />
                <Row label="Status" value={<LivenessIndicator lastSeen={snapshot.lastActive} size="sm" />} />
                <Separator />
                <Row label="Transactions" value={<span className="tabular-nums">{snapshot.txCount.toLocaleString()}</span>} />
                <Separator />
                <Row label="Last Active" value={<span className="text-muted-foreground">{fmtDate(snapshot.lastActive)}</span>} />
              </dl>
            </CardContent>
          </Card>
        </div>
      )}

      {registryAgentId != null ? (
        <Suspense fallback={<RegistrySectionsSkeleton />}>
          <ArcMainnetRegistrySections agentId={registryAgentId} fallbackOwner={registryRow?.owner as string | undefined} />
        </Suspense>
      ) : snapshot && (
        <Card className={CARD}>
          <CardHeader className="pb-3">
            <CardTitle className={CARD_TITLE}>On-chain feedback</CardTitle>
          </CardHeader>
          <CardContent className="text-[13px] text-[#62666d]">
            This address has no ERC-8004 identity on Arc mainnet, so there is no ReputationRegistry record to attest to.
            Feedback opens once the agent registers in the IdentityRegistry.
          </CardContent>
        </Card>
      )}

      <Card className={CARD}>
        <CardHeader className="pb-3">
          <CardTitle className={CARD_TITLE}>Recent mainnet receipts</CardTitle>
        </CardHeader>
        <CardContent>
          {receipts.length === 0 ? <p className="text-sm text-muted-foreground">No mainnet receipts indexed for this address yet.</p> : <ul className="divide-y divide-border">
            {receipts.map(event => <li key={event.eventKey} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <a href={adapter.explorerTxUrl(event.eventKey)} target="_blank" rel="noopener noreferrer" className="min-h-10 max-w-full content-center break-all font-mono underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{event.rawTxHash.slice(0, 12)}… · {event.face === 'provider' ? 'Received' : 'Sent'}</a>
              <span className="font-mono tabular-nums" title={`${event.amountDecimal} USDC`}>{formatUsdcAmount(Number(event.amountDecimal))} USDC</span>
            </li>)}
          </ul>}
        </CardContent>
      </Card>

      {deadMansSwitch}
    </div>
  );
}

function FaceBreakdown({ face }: { face: KarmaFaceBlock }) {
  const m = face.metrics;
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] font-[590] uppercase tracking-[0.08em] text-[#d0d6e0]">
          {face.face === 'provider' ? 'Provider · incoming' : 'Consumer · outgoing'}
        </span>
        <span className="text-[12px] font-[510] tabular-nums text-[#8a8f98]">{faceScore(face)}</span>
      </div>
      {m ? (
        <>
          <MetricBar label="Counterparty breadth" value={m.breadth ?? 0} weight="50%" maxLabel="Unique counterparties / 10" />
          <MetricBar label="Activity" value={m.activity ?? 0} weight="30%" maxLabel="Transactions / 500" />
          <MetricBar label="Continuity" value={m.continuity ?? 0} weight="20%" maxLabel="Observed days / 180" />
          <MetricBar label="Retained value share" value={m.retainedValueShare ?? 0} maxLabel="Net of reciprocal transfers" />
        </>
      ) : (
        <p className="text-[12px] text-[#62666d]">
          No {face.face === 'provider' ? 'incoming' : 'outgoing'} transfers observed.
        </p>
      )}
    </div>
  );
}

/**
 * TAIL — ERC-8004 identity, the ReputationRegistry records (AK validator
 * attestations + third-party reviews) and the give-feedback form. Streamed so
 * the Arc RPC round-trip never delays the header; falls back to the registry
 * mirror when the RPC is down (getCachedEvmAgentOnchain).
 */
async function ArcMainnetRegistrySections({ agentId, fallbackOwner }: { agentId: number; fallbackOwner?: string }) {
  const { agent, feedback } = await getCachedEvmAgentOnchain('arc-mainnet', agentId);
  const [raters, comments] = await Promise.all([
    feedback?.records.length
      ? resolveRaters(feedback.records.map(r => r.client), 'arc-mainnet').catch(() => new Map<string, RaterInfo>())
      : new Map<string, RaterInfo>(),
    feedback?.records.length
      ? getFeedbackComments('arc-mainnet', agentId).catch(() => new Map<string, { comment: string; verified: boolean }>())
      : new Map<string, { comment: string; verified: boolean }>(),
  ]);
  const metadataAssessment = agent?.registration
    ? { result: scoreMetadataQuality(agent), schemeVersion: METADATA_SCHEME_VERSION }
    : null;
  const services = agent?.registration?.services ?? [];
  const owner = agent?.owner ?? fallbackOwner;
  const explorer = getAdapter('arc-mainnet');

  return (
    <>
      <div className="grid gap-6 md:grid-cols-2">
        <Card className={CARD}>
          <CardHeader className="pb-4">
            <CardTitle className={CARD_TITLE}>ERC-8004 identity</CardTitle>
            <p className="mt-1 text-[11px] text-[#62666d]">Read from the Arc mainnet IdentityRegistry</p>
          </CardHeader>
          <CardContent>
            <dl className="space-y-3 text-sm">
              <Row label="agentId" value={<span className="font-mono">{agentId}</span>} />
              <Separator />
              <Row
                label="Owner"
                value={owner
                  ? <a href={explorer.explorerAddressUrl(owner)} target="_blank" rel="noopener noreferrer" className="break-all font-mono text-[12px] hover:underline">{owner}</a>
                  : <span className="text-muted-foreground">—</span>}
              />
              <Separator />
              <Row
                label="agentURI"
                value={agent?.tokenURI
                  ? <span className="break-all text-[12px] text-muted-foreground">{agent.tokenURI.length > 60 ? `${agent.tokenURI.slice(0, 60)}…` : agent.tokenURI}</span>
                  : <span className="text-muted-foreground">—</span>}
              />
              <Separator />
              <Row
                label="IdentityRegistry"
                value={<span className="break-all font-mono text-[12px] text-muted-foreground">{shortAddr(IDENTITY_REGISTRY_ARC_MAINNET)}</span>}
              />
            </dl>
          </CardContent>
        </Card>

        <Card className={CARD}>
          <CardHeader className="pb-4">
            <CardTitle className={CARD_TITLE}>Reputation</CardTitle>
            <p className="mt-1 text-[11px] text-[#62666d]">Arc mainnet ReputationRegistry aggregate</p>
          </CardHeader>
          <CardContent>
            <dl className="space-y-3 text-sm">
              <Row
                label="Feedback (on-chain)"
                value={feedback
                  ? <span className="tabular-nums">{feedback.count} {feedback.count === 1 ? 'record' : 'records'}</span>
                  : <span className="text-muted-foreground">—</span>}
              />
              <Separator />
              <Row
                label="Average"
                value={feedback?.average != null
                  ? <span className="tabular-nums">{feedback.average.toFixed(0)} / 100</span>
                  : <span className="text-muted-foreground">—</span>}
              />
              <Separator />
              <Row
                label="Metadata quality"
                value={metadataAssessment
                  ? <span className="tabular-nums">{metadataAssessment.result.score.toFixed(0)} / 100</span>
                  : <span className="text-muted-foreground">—</span>}
              />
            </dl>
            <p className="mt-4 text-[11px] text-[#62666d]">
              On-chain feedback is shown as evidence; it does not change the transfer-based Karma above.
            </p>
          </CardContent>
        </Card>
      </div>

      {feedback && feedback.records.length > 0 && (
        <FeedbackRecordsCard
          records={feedback.records}
          raters={raters}
          comments={comments}
          chain="arc-mainnet"
          metadataAssessment={metadataAssessment}
        />
      )}

      <GiveFeedbackCard agentId={agentId} chain="arc-mainnet" ownerAddress={owner} />

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
                {s.version && (
                  <span className="ml-3 shrink-0 rounded-full bg-[rgb(255_255_255/0.04)] px-2 py-0.5 text-[10px] text-muted-foreground">{s.version}</span>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </>
  );
}

function RegistrySectionsSkeleton() {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <CardSkeleton title="ERC-8004 identity" rows={4} />
      <CardSkeleton title="Reputation" rows={3} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{value}</dd>
    </div>
  );
}
