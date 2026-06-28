import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink, ShieldCheck, Users } from 'lucide-react';
import {
  getOrganization, getOrganizationMembers, getWallet,
} from '@/db/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScoreRing } from '@/components/karma/score-ring';
import { TierBadge } from '@/components/karma/tier-badge';
import { ConfidenceBadge } from '@/components/karma/confidence-badge';
import { LivenessIndicator } from '@/components/karma/liveness-indicator';
import { WalletAddress } from '@/components/karma/wallet-address';
import type { TrustTier, ConfidenceBadge as ConfidenceBadgeValue, Wallet } from '@/db/schema';

const ROLE_LABELS: Record<string, { label: string; className: string }> = {
  flagship: {
    label: 'Flagship',
    className: 'bg-[rgb(113_112_255/0.12)] text-[#8a92ff] border-[rgb(113_112_255/0.22)]',
  },
  worker: {
    label: 'Worker',
    className: 'bg-[rgb(255_255_255/0.04)] text-[#d0d6e0] border-[rgb(255_255_255/0.08)]',
  },
  readonly: {
    label: 'Readonly',
    className: 'bg-[rgb(255_255_255/0.04)] text-[#8a8f98] border-[rgb(255_255_255/0.08)]',
  },
};

const SITE_URL = 'https://agentkarma.io';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const org = await getOrganization(slug).catch(() => null);
  if (!org) return { title: 'Organization not found' };
  const title = `${org.name} — AgentKarma Fleet`;
  const description = org.description
    ?? `Fleet reputation for ${org.name} on AgentKarma — aggregate Provider Karma across the organization's claimed agent wallets.`;
  return {
    title,
    description,
    alternates: { canonical: `/org/${slug}` },
    openGraph: {
      type: 'profile',
      url: `${SITE_URL}/org/${slug}`,
      title,
      description,
    },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default async function OrgPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const org = await getOrganization(slug);
  if (!org) notFound();

  const members = await getOrganizationMembers(slug);
  const wallets = await Promise.all(
    members.map(async (m) => {
      const w = await getWallet(m.agent_wallet).catch(() => null);
      return { member: m, wallet: w };
    }),
  );

  // Aggregate fleet stats from member wallets
  const presentWallets = wallets
    .map((w) => w.wallet)
    .filter((w): w is Wallet => !!w);

  const memberCount = members.length;
  const avgProviderScore = presentWallets.length > 0
    ? presentWallets.reduce((sum, w) => sum + Number(w.provider_score ?? w.score ?? 0), 0) / presentWallets.length
    : 0;
  const totalTx = presentWallets.reduce((sum, w) => sum + (w.tx_count ?? 0), 0);
  const verifiedCount = presentWallets.filter((w) => w.confidence_badge === 'receipt-backed').length;
  const behaviorCount = presentWallets.filter((w) => w.confidence_badge === 'behavior-inferred').length;
  const declaredCount = presentWallets.filter((w) => w.confidence_badge === 'declared').length;

  const orgLd = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: org.name,
    url: `${SITE_URL}/org/${slug}`,
    description: org.description ?? undefined,
    sameAs: org.website ? [org.website] : undefined,
    member: presentWallets.map((w) => ({
      '@type': 'Thing',
      name: w.display_name ?? w.address,
      identifier: w.address,
      url: `${SITE_URL}/agent/${w.address}`,
    })),
    additionalProperty: [
      { '@type': 'PropertyValue', name: 'Member Agents', value: memberCount },
      { '@type': 'PropertyValue', name: 'Avg Provider Karma', value: Number(avgProviderScore.toFixed(1)), maxValue: 100 },
      { '@type': 'PropertyValue', name: 'Combined Transactions', value: totalTx },
    ],
  };

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'AgentKarma', item: SITE_URL },
      { '@type': 'ListItem', position: 2, name: 'Fleets', item: `${SITE_URL}/enterprise` },
      { '@type': 'ListItem', position: 3, name: org.name, item: `${SITE_URL}/org/${slug}` },
    ],
  };

  return (
    <div className="space-y-10">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: structured-data emission
        dangerouslySetInnerHTML={{ __html: JSON.stringify(orgLd) }}
      />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: structured-data emission
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }}
      />
      {/* Enterprise context strip */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-[rgb(113_112_255/0.18)] bg-[rgb(113_112_255/0.04)] px-3 py-2 text-[11px]">
        <div className="flex items-center gap-2 text-[#8a92ff]">
          <Users className="size-3.5" />
          <span className="font-[510] uppercase tracking-[0.12em]">Enterprise Fleet</span>
          <span className="text-[#62666d]">· Reputation intelligence for agent teams</span>
        </div>
        <Link
          href="/enterprise"
          className="font-[510] text-[#8a92ff] transition-colors hover:text-[#a9b0ff]"
        >
          Contact sales →
        </Link>
      </div>

      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" />
        Back to Leaderboard
      </Link>

      {/* Org header */}
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <h1 className="text-[32px] font-[560] leading-tight tracking-[-0.704px] text-[#f7f8f8]">
              {org.name}
            </h1>
            {org.verified && (
              <Badge
                variant="outline"
                className="gap-1 bg-[rgb(16_185_129/0.10)] text-[#10b981] border-[rgb(16_185_129/0.25)] text-[11px] px-2 py-0.5 font-[510]"
              >
                <ShieldCheck className="size-3" />
                Verified org
              </Badge>
            )}
          </div>
          {org.description && (
            <p className="max-w-xl text-[15px] leading-relaxed text-[#8a8f98]">
              {org.description}
            </p>
          )}
          {org.website && (
            <a
              href={org.website}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[12px] text-[#8a8f98] transition-colors hover:text-[#f7f8f8]"
            >
              {new URL(org.website).hostname}
              <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      </header>

      {/* Fleet stats */}
      <div className="grid gap-3 sm:grid-cols-4">
        <FleetStat label="Agents" value={memberCount.toString()} />
        <FleetStat label="Avg Provider Karma" value={avgProviderScore.toFixed(1)} suffix="/ 100" />
        <FleetStat label="Combined tx volume" value={totalTx.toLocaleString()} />
        <FleetStat
          label="Confidence mix"
          value={
            <span className="inline-flex items-center gap-1.5 text-[13px]">
              <Dot color="#10b981" /><span className="tabular-nums text-[#d0d6e0]">{verifiedCount}</span>
              <Dot color="#f5a623" /><span className="tabular-nums text-[#d0d6e0]">{behaviorCount}</span>
              <Dot color="#8a8f98" /><span className="tabular-nums text-[#d0d6e0]">{declaredCount}</span>
            </span>
          }
        />
      </div>

      {/* Member grid */}
      <section className="space-y-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[17px] font-[590] tracking-[-0.187px] text-[#f7f8f8]">
            Member agents
          </h2>
          <span className="text-[11px] text-[#62666d]">
            Aggregate score updates as member signals refresh
          </span>
        </div>

        {presentWallets.length === 0 ? (
          <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
            <CardContent className="py-12 text-center">
              <p className="text-sm text-[#8a8f98]">No member agents yet.</p>
              <p className="mt-1 text-xs text-[#62666d]">
                Add wallets via <code className="font-mono text-[#d0d6e0]">addOrganizationMember()</code>.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {wallets.map(({ member, wallet }) => (
              <MemberCard
                key={member.id}
                wallet={wallet}
                role={member.role}
                address={member.agent_wallet}
              />
            ))}
          </div>
        )}
      </section>

      {/* Enterprise CTA */}
      <Card className="border-[rgb(113_112_255/0.20)] bg-gradient-to-br from-[rgb(113_112_255/0.06)] to-[rgb(113_112_255/0.02)]">
        <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <p className="text-[14px] font-[590] text-[#f7f8f8]">
              Manage reputation for your agent fleet.
            </p>
            <p className="text-[12px] text-[#8a8f98]">
              Private disputes, webhooks, SLA-backed API, branded embeds, on-prem deploy.
            </p>
          </div>
          <Link
            href="/enterprise"
            className="inline-flex items-center rounded-md bg-[#7170ff] px-3 py-1.5 text-[12.5px] font-[590] text-white transition-colors hover:bg-[#8a92ff]"
          >
            See enterprise plans
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

function FleetStat({
  label,
  value,
  suffix,
}: {
  label: string;
  value: React.ReactNode;
  suffix?: string;
}) {
  return (
    <div className="rounded-lg border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] px-4 py-3">
      <p className="text-[10px] font-[510] uppercase tracking-[0.12em] text-[#62666d]">
        {label}
      </p>
      <div className="mt-1.5 text-[20px] font-[590] tracking-[-0.22px] text-[#f7f8f8]">
        {value}
        {suffix && (
          <span className="ml-1 text-[11px] font-[510] text-[#62666d]">{suffix}</span>
        )}
      </div>
    </div>
  );
}

function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="inline-block size-1.5 rounded-full"
      style={{ background: color }}
    />
  );
}

function MemberCard({
  wallet,
  role,
  address,
}: {
  wallet: Wallet | null;
  role: string | null;
  address: string;
}) {
  const hasData = wallet != null;
  const score = Number(wallet?.provider_score ?? wallet?.score ?? 0);
  const tier = (wallet?.trust_tier ?? 'Unrated') as TrustTier;
  const badge: ConfidenceBadgeValue = wallet?.confidence_badge ?? 'declared';
  const displayName = wallet?.display_name ?? null;
  const description = wallet?.description ?? null;
  const roleCfg = role ? (ROLE_LABELS[role] ?? { label: role, className: ROLE_LABELS.readonly.className }) : null;

  return (
    <Link
      href={`/agent/${address}`}
      className="group block rounded-lg border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] p-4 transition-all hover:border-[rgb(255_255_255/0.16)] hover:bg-[rgb(255_255_255/0.04)]"
    >
      <div className="flex items-start gap-3">
        <ScoreRing score={score} tier={tier} size={52} strokeWidth={4} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-[14px] font-[590] text-[#f7f8f8]">
              {displayName ?? `${address.slice(0, 4)}…${address.slice(-4)}`}
            </p>
            {roleCfg && (
              <Badge variant="outline" className={`text-[9px] px-1.5 py-0 font-[510] ${roleCfg.className}`}>
                {roleCfg.label}
              </Badge>
            )}
          </div>
          <WalletAddress address={address} className="text-[11px] text-[#62666d]" />
          {description && (
            <p className="truncate text-[12px] text-[#8a8f98]" title={description}>
              {description}
            </p>
          )}
        </div>
      </div>
      <Separator className="my-3 bg-[rgb(255_255_255/0.06)]" />
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <TierBadge tier={tier} size="sm" />
          <ConfidenceBadge badge={badge} size="sm" withDot />
        </div>
        {hasData && wallet?.last_seen ? (
          <LivenessIndicator lastSeen={wallet.last_seen} size="sm" showRelative />
        ) : (
          <span className="text-[10px] text-[#62666d]">Idle</span>
        )}
      </div>
    </Link>
  );
}
