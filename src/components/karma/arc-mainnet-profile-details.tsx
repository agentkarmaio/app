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
import { ChainBadge } from './chain-badge';
import { AutonomyChip } from './autonomy-chip';
import { BadgeButton } from './badge-button';
import { ConfidenceBadge } from './confidence-badge';
import { LivenessIndicator } from './liveness-indicator';
import { MetricBar } from './metric-bar';
import { ScoreRing } from './score-ring';
import { TierBadge } from './tier-badge';

const SITE_URL = 'https://agentkarma.io';

const linkStyle = 'inline-flex items-center gap-1 break-all text-[#828fff] underline-offset-2 transition-colors hover:text-[#a3acff] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm';
const cellStyle = 'px-3 py-2.5 text-left align-top';
const CARD = 'min-w-0 scroll-mt-24 border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]';
const CARD_TITLE = 'text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]';
const NOTE = 'text-[11px] leading-relaxed text-[#62666d]';
const CHIP = 'border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.04)] px-1.5 py-0 text-[10px] font-[510] text-[#8a8f98]';
const numberStyle = 'break-all font-mono tabular-nums';
const addressUrl = (address: string) => explorerAddressUrl('arc-mainnet', address);
const transactionUrl = (hash: string) => explorerTxUrl('arc-mainnet', hash);

export function ProfilePanel({ title, intro, children, id }: {
  title: string; intro?: ReactNode; children: ReactNode; id?: string;
}) {
  return <Card id={id} className={CARD}>
    <CardHeader className="pb-4"><CardTitle className={CARD_TITLE}>{title}</CardTitle>
      {intro && <p className={`mt-1 ${NOTE}`}>{intro}</p>}
    </CardHeader><CardContent className="space-y-4">{children}</CardContent>
  </Card>;
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-[rgb(255_255_255/0.05)] py-3 first:pt-0 last:border-0 last:pb-0">
    <dt className="text-sm text-muted-foreground">{label}</dt>
    <dd className="min-w-0 max-w-full break-words text-right text-sm tabular-nums">{children}</dd>
  </div>;
}

export function ProfileDate({ value, empty = 'Not observed', time = true }: {
  value?: string | null; empty?: string;
  /** false → date only, matching the Solana summary rows. */
  time?: boolean;
}) {
  if (!value || !Number.isFinite(Date.parse(value))) return <span className="text-muted-foreground">{empty}</span>;
  const iso = new Date(value).toISOString();
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
    ...(time ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const : {}),
  }).format(new Date(iso));
  return <time dateTime={iso} title={`${iso.slice(0, 16).replace('T', ' ')} UTC`}>{format}{time ? ' UTC' : ''}</time>;
}

function External({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className={linkStyle}>
    {children}<ExternalLink aria-hidden className="size-3 shrink-0 opacity-70" />
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
  return <div className="flex items-start gap-5">
    <FaceRing face={provider} label="Provider Karma" />
    <FaceRing face={consumer} label="Consumer Karma" />
  </div>;
}

const RING = 90;

function FaceRing({ face, label }: { face: KarmaFaceBlock; label: string }) {
  const rated = hasDisplayScore(face);
  return <div className="flex flex-col items-center gap-2">
    {rated ? <ScoreRing score={face.score} tier={displayTier(face)} size={RING} strokeWidth={7} label={`${label} score`} />
      : <div role="img" aria-label={`${label}: unrated`} style={{ width: RING, height: RING }}
          className="flex items-center justify-center rounded-full border-[7px] border-[rgb(255_255_255/0.05)]">
          <span className="text-lg font-[510] text-[#62666d]">—</span>
        </div>}
    <span className="text-[11px] font-[510] text-[#62666d]">{label.replace(' Karma', '')}</span>
  </div>;
}

/** Solana ScoreBreakdownCard's section header: tinted dot, overline label, weight, summary. */
function TierSection({ label, weight, dotColor, summary, children }: {
  label: string; weight?: string; dotColor: string; summary: string; children: ReactNode;
}) {
  return <section className="space-y-3">
    <div className="flex items-baseline justify-between gap-3">
      <div className="flex items-center gap-2">
        <span aria-hidden className="size-1.5 rounded-full" style={{ background: dotColor }} />
        <h3 className="text-[12px] font-[590] uppercase tracking-[0.08em] text-[#d0d6e0]">{label}</h3>
        {weight && <span className="text-[10px] font-[510] text-[#62666d]">{weight}</span>}
      </div>
      <span className="text-[12px] font-[510] tabular-nums text-[#8a8f98]">{summary}</span>
    </div>
    <div className="space-y-3">{children}</div>
  </section>;
}

function faceSummary(face: KarmaFaceBlock): string {
  return hasDisplayScore(face) ? `${face.score.toFixed(1)} / 100` : 'Unrated';
}

function unratedReason(face: KarmaFaceBlock): string {
  return face.hasSignal ? 'A valid score is not available for this snapshot.'
    : face.metrics ? 'Observed activity provides no eligible signal after the reciprocal-transfer guard.'
    : `No eligible ${face.face === 'provider' ? 'incoming' : 'outgoing'} transfer activity is indexed yet. Unrated does not mean a score of zero.`;
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
          { '@type': 'ListItem', position: 2, name: 'Arc', item: `${SITE_URL}/arc/mainnet` },
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
  const tier = displayTier(snapshot.provider);
  const autonomy = snapshot.autonomy;
  return <AgentProfileShell
    back={{ href: '/arc/mainnet', label: 'Arc coverage' }}
    address={snapshot.address}
    chain="arc-mainnet"
    avatarSrc={registration.image}
    name={snapshot.identity.displayName}
    lastSeen={snapshot.lastActive}
    description={snapshot.identity.description}
    category={snapshot.identity.category}
    website={snapshot.identity.website}
    chips={<>
      <TierBadge tier={tier} />
      <ConfidenceBadge badge={snapshot.confidenceBadge} size="sm" />
      <AutonomyChip score={autonomy.score} label={autonomy.label} size="sm" />
      <ChainBadge chain="arc-mainnet" variant="label" />
      {snapshot.agentId != null && <Badge variant="outline" className={CHIP}>Agent #{snapshot.agentId}</Badge>}
    </>}
    actions={<BadgeButton wallet={snapshot.address} chain="arc-mainnet" />}
    score={<ArcMainnetFaceRings provider={snapshot.provider} consumer={snapshot.consumer} />}
  >
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: structured-data emission
      dangerouslySetInnerHTML={{ __html: jsonLd(profileLd(snapshot, name)) }}
    />
    <div className="grid gap-6 md:grid-cols-2">
      <ProfilePanel id="score-breakdown" title="Score Breakdown" intro="Transfer model · behavioral evidence only · missing tiers are not scored">
        {[snapshot.provider, snapshot.consumer].map(face => <TierSection key={face.face}
          label={face.face === 'provider' ? 'Provider · Incoming' : 'Consumer · Outgoing'}
          dotColor={face.face === 'provider' ? '#f5a623' : '#5e6ad2'} summary={faceSummary(face)}>
          {BEHAVIOR_METRICS.map(([key, label, weight, hint]) => {
            const value = unitInterval(face.metrics?.[key]);
            return value == null ? null : <MetricBar key={key} label={label} value={value} weight={weight} maxLabel={hint} />;
          })}
          {!hasDisplayScore(face) && <p className={NOTE}>{unratedReason(face)}</p>}
        </TierSection>)}
        <TierSection label="Autonomy Confidence" dotColor="#8a8f98" summary={autonomy.score != null && autonomy.label ? `${Math.round(autonomy.score)}` : '—'}>
          {autonomy.score != null && autonomy.label ? <>
            {AUTONOMY_METRICS.map(([key, label]) => {
              const value = unitInterval(autonomy.signals?.[key]);
              const weight = unitInterval(autonomy.effectiveWeights?.[key]);
              return value == null ? <p key={key} className="flex justify-between gap-3 text-[12px] text-[#62666d]"><span>{label}</span><span>Not indexed</span></p>
                : <MetricBar key={key} label={label} value={value} weight={weight == null ? undefined : `${Math.round(weight * 100)}%`} />;
            })}
            <p className={NOTE}>Separate axis from {autonomy.txCount.toLocaleString('en-US')} unique transactions — not a Karma component.</p>
          </> : <p className={NOTE}>At least {MIN_TX_FOR_AUTONOMY} unique transactions are required; {snapshot.txCount} observed.</p>}
        </TierSection>
        <p className={`border-t border-[rgb(255_255_255/0.05)] pt-4 ${NOTE}`}>
          Weighted blend × retained value share, then recency decay and evidence-gated tier limits. Transfer size carries no weight; a settled transfer shows payment, not service delivery.
        </p>
      </ProfilePanel>

      <ProfilePanel title="Summary">
        <dl>
          <Stat label="Provider Karma"><span className="font-bold">{faceSummary(snapshot.provider)}</span></Stat>
          <Stat label="Consumer Karma"><span className="font-bold text-muted-foreground">{faceSummary(snapshot.consumer)}</span></Stat>
          <Stat label="Confidence"><ConfidenceBadge badge={snapshot.confidenceBadge} size="sm" /></Stat>
          <Stat label="Autonomy">{autonomy.score != null && autonomy.label
            ? <AutonomyChip score={autonomy.score} label={autonomy.label} size="sm" /> : <span className="text-xs text-muted-foreground">—</span>}</Stat>
          <Stat label="Trust Tier"><TierBadge tier={tier} size="sm" /></Stat>
          <Stat label="Status"><LivenessIndicator lastSeen={snapshot.lastActive} size="sm" /></Stat>
          <Stat label="Transactions">{snapshot.txCount.toLocaleString('en-US')}</Stat>
          <Stat label="First Seen"><span className="text-muted-foreground"><ProfileDate value={evidence?.windowStart} empty="—" time={false} /></span></Stat>
          <Stat label="Last Active"><span className="text-muted-foreground"><ProfileDate value={snapshot.lastActive} empty="—" time={false} /></span></Stat>
        </dl>
        <div className="space-y-3 border-t border-[rgb(255_255_255/0.05)] pt-4">
          <h3 className="text-[12px] font-[590] uppercase tracking-[0.08em] text-[#d0d6e0]">Evidence &amp; Coverage</h3>
          {evidence ? <>
            <dl>
              <Stat label="Transfers in / out">{evidence.received.toLocaleString('en-US')} / {evidence.sent.toLocaleString('en-US')}</Stat>
              <Stat label="Sampled / limit">{evidence.sampledEvents.toLocaleString('en-US')} / {evidence.sampleLimit.toLocaleString('en-US')}</Stat>
              <Stat label="Rejected observations">{evidence.invalid.toLocaleString('en-US')}</Stat>
              <Stat label="Matched reciprocal"><Usdc raw={evidence.matchedReciprocalRawAmount} /></Stat>
            </dl>
            <p className={NOTE}>{evidence.saturated
              ? 'The scoring history limit was reached. Older activity is outside this score; these are not lifetime totals.'
              : 'History limit not reached. Indexer coverage can still be incomplete.'} Model {evidence.model}.</p>
          </> : <p className={NOTE}>Coverage details are unavailable for this snapshot.</p>}
        </div>
      </ProfilePanel>
    </div>

    <ProfilePanel id="identity" title="Registry Identity & Services" intro="Declared metadata from the Arc registry — displayed, never scored.">
      {registryUnavailable ? <p role="status" className="text-sm text-muted-foreground">Registry details could not be loaded. Refresh to retry; the Karma snapshot above is still available.</p>
        : !registry ? <p className="text-sm text-muted-foreground">No registry identity is associated with this payment-wallet profile.</p> : <>
          <div className="grid gap-x-8 md:grid-cols-2">
            <dl>
              <Stat label="Registry agent">#{snapshot.agentId}</Stat>
              <Stat label="Owner"><External href={addressUrl(String(registry.owner))}><span className="font-mono text-[12px]" title={String(registry.owner)}>{short(String(registry.owner))}</span></External></Stat>
              <Stat label="Payment wallet"><External href={addressUrl(snapshot.address)}><span className="font-mono text-[12px]" title={snapshot.address}>{short(snapshot.address)}</span></External></Stat>
              <Stat label="Registration">{metadataText(registry.registration_status) ?? 'Unknown'}</Stat>
            </dl>
            <dl>
              <Stat label="Declared active">{registration.active == null ? '—' : registration.active ? 'Yes · self-declared' : 'No · self-declared'}</Stat>
              <Stat label="Declared x402">{registration.x402Support == null ? '—' : registration.x402Support ? 'Yes · unverified' : 'No · self-declared'}</Stat>
              <Stat label="Metadata URI">{safeHref(metadataText(registry.token_uri, 2048))
                ? <External href={safeHref(metadataText(registry.token_uri, 2048))!}>Registration</External>
                : <span className="break-all text-muted-foreground">{metadataText(registry.token_uri, 200) ?? '—'}</span>}</Stat>
              <Stat label="Last indexed"><span className="text-muted-foreground"><ProfileDate value={metadataText(registry.last_indexed_at)} empty="—" time={false} /></span></Stat>
            </dl>
          </div>
          {registration.services.length ? <div className="space-y-2">
            {registration.services.map((service, index) => <div key={`${service.name}:${index}`}
              className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-[rgb(255_255_255/0.05)] bg-[rgb(255_255_255/0.02)] px-3 py-2">
              <span className="truncate text-[13px] font-[510] text-[#f7f8f8]">{service.name}</span>
              {service.endpoint ? <External href={service.endpoint}><span className="truncate font-mono text-[11.5px]">{service.endpoint}</span></External>
                : <span className="text-[11.5px] text-[#62666d]">No supported endpoint URL declared.</span>}
            </div>)}
          </div> : <p className={NOTE}>No services are present in the indexed registration metadata.</p>}
          {registration.servicesTruncated && <p className={NOTE}>Only the first 10 declared service entries are shown.</p>}
          <p className={NOTE}>Endpoints are linked, not invoked or availability-checked.</p>
        </>}
    </ProfilePanel>
    {children}
  </AgentProfileShell>;
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function ReceiptTable({ receipts }: { receipts: ProfileActivity['receipts'] }) {
  return <div className="overflow-x-auto"><table className="w-full text-sm">
    <caption className="sr-only">Validated Arc transfer receipts</caption>
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
  return <ProfilePanel id="feedback" title="Registry Feedback" intro={`Read-only Arc registry mirror · up to ${PROFILE_FEEDBACK_LIMIT} newest indexed records. Tags and decimal scales are preserved; different feedback schemes are not averaged together or included in Karma.`}>
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
