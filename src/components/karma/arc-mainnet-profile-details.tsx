import type { ReactNode } from 'react';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import type { KarmaFaceBlock, KarmaSnapshot } from '@/lib/karma-resolver';
import type { EnrichmentFeedbackRow } from '@/lib/karma-enrichment';
import {
  displayTier, formatRawUnits, hasDisplayScore, metadataText, readProfileRegistration,
  unitInterval, PROFILE_FEEDBACK_LIMIT, PROFILE_RECEIPT_LIMIT, type ProfileActivity,
} from '@/lib/arc-mainnet-profile';
import { ARC_MAINNET_TRANSFER_DECIMALS } from '@/config/arc-mainnet';
import { MIN_TX_FOR_AUTONOMY } from '@/scoring/autonomy';
import { explorerAddressUrl, explorerTxUrl } from '@/lib/explorer-urls';
import { jsonLd } from '@/lib/json-ld';
import { safeHref } from '@/lib/safe-url';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AgentProfileShell } from './agent-profile-shell';
import { AutonomyChip } from './autonomy-chip';
import { BadgeButton } from './badge-button';
import { ConfidenceBadge } from './confidence-badge';
import { LivenessIndicator } from './liveness-indicator';
import { MetricBar } from './metric-bar';
import { ScoreRing } from './score-ring';
import { TierBadge } from './tier-badge';

const SITE_URL = 'https://agentkarma.io';

const linkStyle = 'inline-flex min-h-10 items-center gap-1.5 break-all text-sm underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const cellStyle = 'px-3 py-3 text-left align-top';
const numberStyle = 'break-all font-mono tabular-nums';
const addressUrl = (address: string) => explorerAddressUrl('arc-mainnet', address);
const transactionUrl = (hash: string) => explorerTxUrl('arc-mainnet', hash);

export function ProfilePanel({ title, intro, children, id }: {
  title: string; intro?: ReactNode; children: ReactNode; id?: string;
}) {
  return <Card id={id} className="min-w-0 scroll-mt-24 border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
    <CardHeader><CardTitle className="text-[15px] font-semibold">{title}</CardTitle>
      {intro && <p className="text-xs leading-relaxed text-muted-foreground">{intro}</p>}
    </CardHeader><CardContent className="space-y-4">{children}</CardContent>
  </Card>;
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-b border-border/50 py-2.5 last:border-0">
    <dt className="text-sm text-muted-foreground">{label}</dt>
    <dd className="min-w-0 max-w-full break-words text-sm tabular-nums">{children}</dd>
  </div>;
}

export function ProfileDate({ value, empty = 'Not observed' }: { value?: string | null; empty?: string }) {
  if (!value || !Number.isFinite(Date.parse(value))) return <span className="text-muted-foreground">{empty}</span>;
  const iso = new Date(value).toISOString();
  return <time dateTime={iso}>{new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(iso))} UTC</time>;
}

function External({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className={linkStyle}>
    {children}<ExternalLink aria-hidden className="size-3.5 shrink-0" />
  </a>;
}

function Usdc({ raw }: { raw: string }) {
  return <span className={numberStyle}>{formatRawUnits(raw, ARC_MAINNET_TRANSFER_DECIMALS) ?? 'Unavailable'} USDC</span>;
}

/**
 * Both faces side by side in the header — invariant #3 forbids collapsing them
 * into one score, and the shared shell's `score` slot takes a node for exactly
 * this reason. The rings live here; the body cards carry the numbers and the
 * model caveats.
 */
export function ArcMainnetFaceRings({ provider, consumer }: { provider: KarmaFaceBlock; consumer: KarmaFaceBlock }) {
  return <div className="flex items-start gap-6">
    <FaceRing face={provider} label="Provider Karma" />
    <FaceRing face={consumer} label="Consumer Karma" />
  </div>;
}

function FaceRing({ face, label }: { face: KarmaFaceBlock; label: string }) {
  const rated = hasDisplayScore(face);
  return <div className="flex w-[72px] flex-col items-center gap-1.5">
    {rated ? <ScoreRing score={face.score} tier={displayTier(face)} size={72} strokeWidth={6} label={`${label} score`} />
      : <div className="flex size-[72px] items-center justify-center rounded-full border border-border text-[11px] text-muted-foreground">Unrated</div>}
    <span className="text-center text-[11px] font-[510] text-[#8a8f98]">{label}</span>
  </div>;
}

function FaceCard({ face }: { face: KarmaFaceBlock }) {
  const rated = hasDisplayScore(face);
  const incoming = face.face === 'provider';
  return <ProfilePanel title={incoming ? 'Provider Karma' : 'Consumer Karma'} intro={incoming ? 'Observed incoming payments' : 'Observed outgoing payments'}>
    <div className="space-y-2">
      <p className="font-mono text-2xl tabular-nums">{rated ? `${face.score.toFixed(1)} / 100` : 'Unrated'}</p>
      <div className="flex flex-wrap gap-2"><TierBadge tier={displayTier(face)} size="sm" /><ConfidenceBadge badge={face.confidenceBadge} size="sm" /></div>
    </div>
    {!rated && <p className="text-xs text-muted-foreground">{face.hasSignal
      ? 'A valid score is not available for this snapshot.' : face.metrics
      ? 'Observed activity does not currently provide eligible scoring signal after the reciprocal-transfer guard.'
      : `No eligible ${incoming ? 'incoming' : 'outgoing'} transfer activity is indexed yet. Unrated does not mean a score of zero.`}</p>}
    <p className="text-xs text-muted-foreground">A settled transfer shows payment movement, not successful service delivery.</p>
  </ProfilePanel>;
}

const BEHAVIOR_METRICS = [
  ['breadth', 'Counterparty diversity', '50%', 'Unique counterparties / 10, capped by unique transactions'],
  ['activity', 'Activity', '30%', 'Unique transaction hashes / 500'],
  ['continuity', 'Observed continuity', '20%', 'Time between first and last observed transfer / 180 days'],
  ['retainedValueShare', 'Retained value share', 'Multiplier', 'Value remaining after matched reciprocal transfers are discounted'],
] as const;

const AUTONOMY_METRICS = [
  ['cadence_regularity', 'Cadence regularity'], ['latency_variance', 'Inter-transaction timing'],
  ['concurrent_depth', 'Clustered activity'], ['counterparty_breadth', 'Counterparty breadth'],
  ['memo_determinism', 'Memo determinism'], ['compute_efficiency', 'Compute efficiency'],
] as const;

/**
 * Breadcrumb + agent description for crawlers. Only faces with a display score
 * are published, so structured data can never claim a rating the page refuses
 * to show.
 */
function profileLd(snapshot: KarmaSnapshot, name: string) {
  const profileUrl = `${SITE_URL}/agent/${snapshot.address}?chain=arc-mainnet`;
  const face = (label: string, block: KarmaFaceBlock) => hasDisplayScore(block)
    ? [{ '@type': 'PropertyValue', name: label, value: Number(block.score.toFixed(1)), maxValue: 100 }] : [];
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'AgentKarma', item: SITE_URL },
          { '@type': 'ListItem', position: 2, name: 'Arc mainnet', item: `${SITE_URL}/arc/mainnet` },
          { '@type': 'ListItem', position: 3, name, item: profileUrl },
        ],
      },
      {
        '@type': 'Thing',
        name,
        identifier: snapshot.address,
        url: profileUrl,
        ...(snapshot.identity.description ? { description: snapshot.identity.description } : {}),
        sameAs: [addressUrl(snapshot.address)],
        additionalProperty: [
          ...face('Provider Karma', snapshot.provider),
          ...face('Consumer Karma', snapshot.consumer),
          { '@type': 'PropertyValue', name: 'Trust Tier', value: displayTier(snapshot.provider) },
          { '@type': 'PropertyValue', name: 'Confidence Badge', value: snapshot.confidenceBadge },
          ...(snapshot.autonomy.score != null && snapshot.autonomy.label
            ? [{ '@type': 'PropertyValue', name: 'Autonomy Confidence', value: Math.round(snapshot.autonomy.score), unitText: snapshot.autonomy.label }]
            : []),
          { '@type': 'PropertyValue', name: 'Transactions Indexed', value: snapshot.txCount },
        ],
      },
    ],
  };
}

export function ArcMainnetProfileOverview({ snapshot, registry, registryUnavailable, children }: {
  snapshot: KarmaSnapshot; registry: Record<string, unknown> | null; registryUnavailable: boolean;
  /** Streamed sections (trend, feedback, payments) the profile drops in below the static body. */
  children?: ReactNode;
}) {
  const name = snapshot.identity.displayName || 'Agent profile';
  const registration = readProfileRegistration(registry?.registration);
  const evidence = snapshot.receiptEvidence;
  return <AgentProfileShell
    back={{ href: '/arc/mainnet', label: 'Arc mainnet coverage' }}
    address={snapshot.address}
    chain="arc-mainnet"
    avatarSrc={registration.image}
    name={snapshot.identity.displayName}
    lastSeen={snapshot.lastActive}
    description={snapshot.identity.description}
    category={snapshot.identity.category}
    website={snapshot.identity.website}
    chips={<>
      <Badge variant="outline">Arc mainnet</Badge>
      {snapshot.agentId != null && <Badge variant="outline">Agent #{snapshot.agentId}</Badge>}
      <AutonomyChip score={snapshot.autonomy.score} label={snapshot.autonomy.label} size="sm" />
    </>}
    actions={<BadgeButton wallet={snapshot.address} chain="arc-mainnet" />}
    score={<ArcMainnetFaceRings provider={snapshot.provider} consumer={snapshot.consumer} />}
  >
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: structured-data emission
      dangerouslySetInnerHTML={{ __html: jsonLd(profileLd(snapshot, name)) }}
    />
    <nav aria-label="Agent profile sections" className="flex flex-wrap gap-x-5 border-y border-border py-2">
      {[['score-breakdown', 'Scores'], ['identity', 'Identity'], ['score-trend', 'History'], ['feedback', 'Feedback'], ['payments', 'Payments']].map(([id, label]) =>
        <a key={id} href={`#${id}`} className={linkStyle}>{label}</a>)}
    </nav>
    <div className="grid gap-6 md:grid-cols-2"><FaceCard face={snapshot.provider} /><FaceCard face={snapshot.consumer} /></div>
    <div className="grid gap-6 lg:grid-cols-2">
      <ProfilePanel id="score-breakdown" title="Score Breakdown" intro="Arc mainnet transfer model · Tier 2 behavioral evidence only. The scores above come from the shared Karma resolver.">
        {[snapshot.provider, snapshot.consumer].map(face => <section key={face.face} className="space-y-4 border-b border-border pb-5 last:border-0 last:pb-0">
          <h3 className="text-sm font-medium">{face.face === 'provider' ? 'Provider · Incoming' : 'Consumer · Outgoing'}</h3>
          {BEHAVIOR_METRICS.map(([key, label, weight, hint]) => {
            const value = unitInterval(face.metrics?.[key]);
            return value == null ? <p key={key} className="flex justify-between gap-3 text-xs text-muted-foreground"><span>{label}</span><span>No observations</span></p>
              : <MetricBar key={key} label={label} value={value} weight={weight} maxLabel={hint} />;
          })}
        </section>)}
        <p className="text-xs leading-relaxed text-muted-foreground">The weighted behavior blend is multiplied by retained value share, then canonical recency decay and evidence-based tier limits apply. Transfer size has no positive score weight.</p>
        <dl><Stat label="Tier 1 · Delivery receipts">Not used by this transfer-only model</Stat>
          <Stat label="Tier 3 · Declared identity">Displayed separately; not scored</Stat>
          <Stat label="Tier 4 · Social">Not used by this model</Stat>
          <Stat label="Service success rate">Not established by settled transfers</Stat></dl>
      </ProfilePanel>
      <div className="min-w-0 space-y-6">
        <ProfilePanel title="Summary" intro="Activity dates describe validated transfers, never registry scan times.">
          <dl><Stat label="Network">Arc mainnet</Stat>
            <Stat label="Unique transactions in score window">{snapshot.txCount.toLocaleString('en-US')}</Stat>
            <Stat label="Received transfer logs">{evidence?.received.toLocaleString('en-US') ?? 'Unavailable'}</Stat>
            <Stat label="Sent transfer logs">{evidence?.sent.toLocaleString('en-US') ?? 'Unavailable'}</Stat>
            <Stat label="First transfer in score window"><ProfileDate value={evidence?.windowStart} /></Stat>
            <Stat label="Last active"><ProfileDate value={snapshot.lastActive} /></Stat>
            <Stat label="Status"><LivenessIndicator lastSeen={snapshot.lastActive} size="sm" /></Stat></dl>
        </ProfilePanel>
        <ProfilePanel title="Autonomy Confidence" intro="A separate behavioral axis, not a component of Karma or proof of autonomous operation.">
          {snapshot.autonomy.score != null && snapshot.autonomy.label ? <>
            <AutonomyChip score={snapshot.autonomy.score} label={snapshot.autonomy.label} />
            <p className="text-xs text-muted-foreground">Based on {snapshot.autonomy.txCount.toLocaleString('en-US')} unique transactions.</p>
            {AUTONOMY_METRICS.map(([key, label]) => {
              const value = unitInterval(snapshot.autonomy.signals?.[key]);
              const weight = unitInterval(snapshot.autonomy.effectiveWeights?.[key]);
              return value == null ? <p key={key} className="flex justify-between gap-3 text-xs text-muted-foreground"><span>{label}</span><span>Not indexed</span></p>
                : <MetricBar key={key} label={label} value={value} weight={weight == null ? undefined : `${Math.round(weight * 100)}%`} />;
            })}
          </> : <p className="text-sm text-muted-foreground">Not enough activity to assess yet. At least {MIN_TX_FOR_AUTONOMY} unique transactions are required; {snapshot.txCount} are currently observed.</p>}
        </ProfilePanel>
      </div>
    </div>
    <ProfilePanel title="Evidence & Coverage" intro="Mainnet native-USDC transfers are observed payment evidence, not x402 delivery attestations.">
      {evidence ? <>
        <dl className="grid gap-x-8 md:grid-cols-2"><Stat label="Scoring model">{evidence.model}</Stat>
          <Stat label="Sampled events / limit">{evidence.sampledEvents.toLocaleString('en-US')} / {evidence.sampleLimit.toLocaleString('en-US')}</Stat>
          <Stat label="Rejected or conflicting observations">{evidence.invalid.toLocaleString('en-US')}</Stat>
          <Stat label="Matched reciprocal amount"><Usdc raw={evidence.matchedReciprocalRawAmount} /></Stat></dl>
        <p className="text-xs text-muted-foreground">{evidence.saturated
          ? 'The scoring history limit was reached. Older activity is outside this score; these figures are not lifetime totals.'
          : 'The scoring read did not reach its history limit. Indexer coverage can still be incomplete; no indexed receipts does not prove no on-chain activity.'} Reciprocal transfers are discounted only within the observed window. This is not proof of counterparty independence.</p>
      </> : <p className="text-sm text-muted-foreground">Coverage details are unavailable for this snapshot.</p>}
    </ProfilePanel>
    <ProfilePanel id="identity" title="Registry Identity & Services" intro="Declared metadata from the Arc mainnet registry mirror. Neither metadata nor registry feedback increases the transfer score.">
      {registryUnavailable ? <p role="status" className="text-sm text-muted-foreground">Registry details could not be loaded. Refresh to retry; the Karma snapshot above is still available.</p>
        : !registry ? <p className="text-sm text-muted-foreground">No registry identity is associated with this payment-wallet profile.</p> : <>
          <dl><Stat label="Registry agent">#{snapshot.agentId}</Stat>
            <Stat label="Owner"><External href={addressUrl(String(registry.owner))}>{String(registry.owner)}</External></Stat>
            <Stat label="Scored payment wallet"><External href={addressUrl(snapshot.address)}>{snapshot.address}</External></Stat>
            <Stat label="Registration status">{metadataText(registry.registration_status) ?? 'Unknown'}</Stat>
            <Stat label="Declared active">{registration.active == null ? 'Not declared' : registration.active ? 'Yes (self-declared)' : 'No (self-declared)'}</Stat>
            <Stat label="Declared x402 support">{registration.x402Support == null ? 'Not declared' : registration.x402Support ? 'Yes (unverified)' : 'No (self-declared)'}</Stat>
            <Stat label="Metadata URI">{safeHref(metadataText(registry.token_uri, 2048))
              ? <External href={safeHref(metadataText(registry.token_uri, 2048))!}>View registration document</External>
              : <span className="break-all">{metadataText(registry.token_uri, 200) ?? 'Not available'}</span>}</Stat>
            <Stat label="Registry last indexed"><ProfileDate value={metadataText(registry.last_indexed_at)} empty="Not available" /></Stat></dl>
          <h3 className="text-sm font-medium">Declared services</h3>
          {registration.services.length ? <ul className="divide-y divide-border">{registration.services.map((service, index) => <li key={`${service.name}:${index}`} className="min-w-0 py-3">
            <p className="text-sm font-medium">{service.name}</p>
            {service.endpoint ? <External href={service.endpoint}>{service.endpoint}</External> : <p className="text-xs text-muted-foreground">No supported endpoint URL declared.</p>}
          </li>)}</ul> : <p className="text-sm text-muted-foreground">No services are present in the indexed registration metadata.</p>}
          {registration.servicesTruncated && <p className="text-xs text-muted-foreground">Only the first 10 declared service entries are shown.</p>}
          <p className="text-xs text-muted-foreground">Endpoints are linked, not invoked or availability-checked. Declared active status is independent of observed liveness.</p>
        </>}
    </ProfilePanel>
    {children}
  </AgentProfileShell>;
}

function ReceiptTable({ receipts }: { receipts: ProfileActivity['receipts'] }) {
  return <div className="overflow-x-auto"><table className="w-full text-sm">
    <caption className="sr-only">Validated Arc mainnet transfer receipts</caption>
    <thead><tr className="border-b border-border text-xs text-muted-foreground">
      {['Direction', 'Amount', 'Counterparty', 'Time (UTC)', 'Transaction / log'].map(label => <th scope="col" className={cellStyle} key={label}>{label}</th>)}
    </tr></thead><tbody>{receipts.map(receipt => <tr className="border-b border-border/50" key={receipt.eventKey}>
      <td className={cellStyle}>{receipt.face === 'provider' ? 'Received' : 'Sent'}</td>
      <td className={cellStyle}><Usdc raw={receipt.rawAmount} /></td>
      <td className={cellStyle}><External href={addressUrl(receipt.counterparty)}><span title={receipt.counterparty}>{receipt.counterparty.slice(0, 8)}…{receipt.counterparty.slice(-6)}</span></External></td>
      <td className={cellStyle}><ProfileDate value={receipt.timestamp} /></td>
      <td className={cellStyle}><External href={transactionUrl(receipt.rawTxHash)}><span title={receipt.rawTxHash}>{receipt.rawTxHash.slice(0, 12)}… · #{receipt.logIndex}</span></External></td>
    </tr>)}</tbody>
  </table></div>;
}

function RelationshipTable({ rows }: { rows: ProfileActivity['relationships'] }) {
  return <div className="overflow-x-auto"><table className="w-full text-sm">
    <caption className="sr-only">Counterparties in the recent indexed transfer window</caption>
    <thead><tr className="border-b border-border text-xs text-muted-foreground">
      {['Counterparty', 'Received', 'Sent', 'Transactions / logs', 'Last observed'].map(label => <th scope="col" className={cellStyle} key={label}>{label}</th>)}
    </tr></thead><tbody>{rows.map(row => <tr key={row.address} className="border-b border-border/50">
      <td className={cellStyle}><Link className={linkStyle} title={row.address} href={`/agent/${row.address}?chain=arc-mainnet`}>{row.address.slice(0, 8)}…{row.address.slice(-6)}</Link></td>
      <td className={cellStyle}><Usdc raw={row.receivedRaw} /></td><td className={cellStyle}><Usdc raw={row.sentRaw} /></td>
      <td className={`${cellStyle} tabular-nums`}>{row.transactions} / {row.transfers}</td>
      <td className={cellStyle}><ProfileDate value={row.lastActive} /></td>
    </tr>)}</tbody>
  </table></div>;
}

export function ArcMainnetActivityDetails({ activity, saturated, sampled, invalid }: {
  activity: ProfileActivity; saturated: boolean; sampled: number; invalid: number;
}) {
  return <div id="payments" className="scroll-mt-24 space-y-6">
    <ProfilePanel title="Payment Relationships" intro={`Recent indexed window: ${sampled} of at most ${PROFILE_RECEIPT_LIMIT} events, ${activity.receipts.length} validated transfer logs, ${activity.transactions} unique transactions. These are gross observed amounts before reciprocal discounting, not lifetime totals or the full scoring window.`}>
      <dl className="grid gap-x-8 md:grid-cols-3"><Stat label="Received"><Usdc raw={activity.receivedRaw} /></Stat>
        <Stat label="Sent"><Usdc raw={activity.sentRaw} /></Stat><Stat label="Counterparties">{activity.relationships.length}</Stat></dl>
      {activity.relationships.length ? <>
        <RelationshipTable rows={activity.relationships.slice(0, 20)} />
        {activity.relationships.length > 20 && <details><summary className="cursor-pointer py-3 text-sm underline">Additional {activity.relationships.length - 20} counterparties</summary><RelationshipTable rows={activity.relationships.slice(20)} /></details>}
      </> : <p className="text-sm text-muted-foreground">No payment relationships can be derived from the indexed transfer window yet.</p>}
      {saturated && <p className="text-xs text-muted-foreground">The recent-event limit was reached; older transfers and relationships are not included here.</p>}
      {invalid > 0 && <p className="text-xs text-muted-foreground">{invalid} invalid or conflicting observations were excluded.</p>}
    </ProfilePanel>
    <ProfilePanel title="Recent mainnet receipts" intro="Native USDC · received and sent directions · amounts preserve the full 18-decimal precision. A transaction can contain multiple transfer logs.">
      {activity.receipts.length ? <>
        <ReceiptTable receipts={activity.receipts.slice(0, 50)} />
        {activity.receipts.length > 50 && <details><summary className="cursor-pointer py-3 text-sm underline">Additional {activity.receipts.length - 50} indexed transfers</summary><ReceiptTable receipts={activity.receipts.slice(50)} /></details>}
      </> : <p className="text-sm text-muted-foreground">No valid mainnet receipts are indexed in this window yet. This does not establish the absence of on-chain activity.</p>}
    </ProfilePanel>
  </div>;
}

export function ArcMainnetRegistryFeedback({ rows }: { rows: EnrichmentFeedbackRow[] }) {
  return <ProfilePanel id="feedback" title="Registry Feedback" intro={`Read-only Arc mainnet registry mirror · up to ${PROFILE_FEEDBACK_LIMIT} newest indexed records. Tags and decimal scales are preserved; different feedback schemes are not averaged together or included in Karma.`}>
    {rows.length ? <>
      <p className="text-xs text-muted-foreground">{rows.filter(row => !row.revoked).length} non-revoked / {rows.length} shown. Indexing time is not the feedback submission time.</p>
      <ul className="divide-y divide-border">{rows.map((row, index) => <li key={`${row.agent_id}:${row.client}:${row.feedback_index}:${index}`} className="space-y-2 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <External href={addressUrl(row.client)}>{row.client}</External>
          <span className={`${numberStyle} ${row.revoked ? 'line-through text-muted-foreground' : ''}`}>{row.value == null || row.value_decimals == null ? 'Value unavailable' : formatRawUnits(row.value, row.value_decimals) ?? 'Value unavailable'}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{metadataText(row.tag1) ?? 'Untagged'}</Badge>
          {row.tag2 && <Badge variant="outline">{metadataText(row.tag2)}</Badge>}
          {row.revoked && <Badge variant="outline">Revoked · excluded</Badge>}
          <span className="text-xs text-muted-foreground">Indexed <ProfileDate value={row.indexed_at} empty="at an unknown time" /></span></div>
      </li>)}</ul>
      {rows.length === PROFILE_FEEDBACK_LIMIT && <p className="text-xs text-muted-foreground">The display limit was reached; older feedback may exist.</p>}
    </> : <p className="text-sm text-muted-foreground">No registry feedback is indexed for this agent yet.</p>}
  </ProfilePanel>;
}
