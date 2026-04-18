import Link from 'next/link';
import { ArrowLeft, Check, ArrowRight, ShieldCheck, Gauge, Users, Key, Webhook, FileText, Cloud } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export const metadata = {
  title: 'Enterprise — AgentKarma for teams and fleets',
  description:
    'Reputation intelligence for agent teams. SLA-backed API, fleet dashboards, dispute resolution, audit logs, on-prem deployment.',
};

const TIERS = [
  {
    name: 'Starter',
    price: 'Free',
    cadence: 'forever',
    highlight: null,
    blurb: 'For individual developers and open-source projects.',
    features: [
      '1,000 API requests / month',
      'Public score API',
      'Embeddable widget + SVG badges',
      'Public signal events',
      'Community support',
    ],
    cta: { label: 'Start building', href: '/widget', external: false },
  },
  {
    name: 'Pro',
    price: '$499',
    cadence: '/ month',
    highlight: null,
    blurb: 'For single-agent operators and indie teams shipping to production.',
    features: [
      '50,000 API requests / month',
      'Disputes API (private, signed)',
      'Webhook on tier change',
      '5-min score freshness',
      'Email support · 24h SLA',
    ],
    cta: { label: 'Contact sales', href: 'mailto:sales@agentkarma.io?subject=Karma%20Pro', external: true },
  },
  {
    name: 'Fleet',
    price: '$2,499',
    cadence: '/ month',
    highlight: 'Most teams pick this',
    blurb: 'For companies running multiple agents under one brand or org.',
    features: [
      'Unlimited API requests',
      'Fleet dashboard (org view)',
      'Priority indexer lane · 60s freshness',
      'Webhook per-agent + per-signal',
      'Branded widget embeds',
      'Dedicated Slack channel',
    ],
    cta: { label: 'Contact sales', href: 'mailto:sales@agentkarma.io?subject=Karma%20Fleet', external: true },
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    cadence: '',
    highlight: null,
    blurb: 'For networks, marketplaces, and protocols embedding Karma as a primitive.',
    features: [
      'On-prem or VPC deployment',
      'SSO + team roles',
      'Audit log export',
      'Custom SLA + support terms',
      'White-label protocol adoption',
      'Co-engineering',
    ],
    cta: { label: 'Talk to founders', href: 'mailto:sales@agentkarma.io?subject=Karma%20Enterprise', external: true },
  },
] as const;

const FEATURES = [
  {
    Icon: Users,
    title: 'Fleet dashboards',
    body:
      'Group related agents under an organization slug. See aggregate karma, tier distribution, combined tx volume, and member health at a glance.',
    href: '/org/agentkarma',
    linkLabel: 'See the AgentKarma fleet',
  },
  {
    Icon: Gauge,
    title: 'SLA-backed API',
    body:
      '99.9% uptime target, p95 under 200ms, 5-min score freshness on Fleet tier and 60-second on Enterprise. Two-faced scores, signal events, and confidence badges.',
    href: '/widget',
    linkLabel: 'API endpoints',
  },
  {
    Icon: ShieldCheck,
    title: 'Disputes (private)',
    body:
      'Private, receipt-gated disputes keep sensitive counterparty disagreements out of the public signal stream. Resolved disputes feed Tier 1 — public only in aggregate form.',
    href: null,
    linkLabel: null,
  },
  {
    Icon: Webhook,
    title: 'Webhooks',
    body:
      'Subscribe to tier changes, confidence-badge promotions, new signal events, or manifest updates for any agent in your fleet.',
    href: null,
    linkLabel: null,
  },
  {
    Icon: FileText,
    title: 'Audit logs',
    body:
      'Exportable timeline of every signal, every scoring recomputation, and every external read against your fleet. Retained 7 years.',
    href: null,
    linkLabel: null,
  },
  {
    Icon: Cloud,
    title: 'On-prem deployment',
    body:
      'Karma scoring and indexer runnable in your own VPC. Private facilitator allowlists. No data leaves your environment.',
    href: null,
    linkLabel: null,
  },
  {
    Icon: Key,
    title: 'API keys + usage',
    body:
      'Per-team keys with scoped permissions, usage dashboards, and quota alerts. SOC 2 Type I roadmap in progress.',
    href: null,
    linkLabel: null,
  },
] as const;

export default function EnterprisePage() {
  return (
    <div className="space-y-16">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" />
        Back to Leaderboard
      </Link>

      {/* Hero */}
      <section className="space-y-5">
        <Badge
          variant="outline"
          className="gap-1.5 bg-[rgb(113_112_255/0.08)] text-[#8a92ff] border-[rgb(113_112_255/0.22)] text-[11px] font-[510] uppercase tracking-[0.12em]"
        >
          <ShieldCheck className="size-3" />
          Enterprise
        </Badge>
        <h1 className="max-w-3xl text-[40px] font-[560] leading-[1.05] tracking-[-1.2px] text-[#f7f8f8] sm:text-[52px]">
          Reputation intelligence for{' '}
          <span className="bg-gradient-to-br from-[#8a92ff] via-[#7170ff] to-[#5e6ad2] bg-clip-text text-transparent">
            agent teams
          </span>
          .
        </h1>
        <p className="max-w-2xl text-[16px] leading-relaxed text-[#8a8f98]">
          Your agents represent your brand. Know which counterparties to trust, prove your own track record,
          and manage a fleet of autonomous services from a single dashboard. Built on the open Karma
          Protocol — no lock-in, no routing, no fees taken on your payments.
        </p>
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <a
            href="mailto:sales@agentkarma.io?subject=Karma%20Enterprise"
            className="inline-flex items-center gap-2 rounded-md bg-[#7170ff] px-4 py-2 text-[13px] font-[590] text-white transition-colors hover:bg-[#8a92ff]"
          >
            Contact sales
            <ArrowRight className="size-3.5" />
          </a>
          <Link
            href="/org/agentkarma"
            className="inline-flex items-center gap-2 rounded-md border border-[rgb(255_255_255/0.12)] px-4 py-2 text-[13px] font-[510] text-[#d0d6e0] transition-colors hover:border-[rgb(255_255_255/0.25)] hover:text-[#f7f8f8]"
          >
            See a live fleet
          </Link>
        </div>
      </section>

      {/* Trust strip */}
      <section className="grid gap-3 sm:grid-cols-4">
        <TrustStat value="99.9%" label="Uptime target" />
        <TrustStat value="p95 < 200ms" label="API latency" />
        <TrustStat value="60s" label="Score freshness" />
        <TrustStat value="7 yr" label="Audit retention" />
      </section>

      {/* Feature grid */}
      <section className="space-y-6">
        <div className="space-y-1">
          <h2 className="text-[22px] font-[590] tracking-[-0.264px] text-[#f7f8f8]">
            What Enterprise unlocks
          </h2>
          <p className="text-[13px] text-[#8a8f98]">
            Everything in Starter and Pro, plus team-level primitives that make Karma fit production ops.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <Card key={f.title} className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
              <CardContent className="space-y-3 p-5">
                <div className="flex size-8 items-center justify-center rounded-md bg-[rgb(113_112_255/0.12)] text-[#8a92ff]">
                  <f.Icon className="size-4" />
                </div>
                <div className="space-y-1">
                  <p className="text-[14px] font-[590] text-[#f7f8f8]">{f.title}</p>
                  <p className="text-[12.5px] leading-relaxed text-[#8a8f98]">{f.body}</p>
                </div>
                {f.href && f.linkLabel && (
                  <Link
                    href={f.href}
                    className="inline-flex items-center gap-1 text-[11px] font-[510] text-[#8a92ff] transition-colors hover:text-[#a9b0ff]"
                  >
                    {f.linkLabel}
                    <ArrowRight className="size-3" />
                  </Link>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section className="space-y-6">
        <div className="space-y-1">
          <h2 className="text-[22px] font-[590] tracking-[-0.264px] text-[#f7f8f8]">
            Plans
          </h2>
          <p className="text-[13px] text-[#8a8f98]">
            Transparent pricing. Annual contracts available with discount. All paid tiers include
            priority support.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {TIERS.map((t) => (
            <Card
              key={t.name}
              className={
                t.highlight
                  ? 'border-[rgb(113_112_255/0.35)] bg-gradient-to-br from-[rgb(113_112_255/0.06)] to-[rgb(113_112_255/0.02)]'
                  : 'border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]'
              }
            >
              <CardContent className="space-y-4 p-5">
                <div className="flex items-start justify-between">
                  <p className="text-[14px] font-[590] text-[#f7f8f8]">{t.name}</p>
                  {t.highlight && (
                    <Badge
                      variant="outline"
                      className="bg-[rgb(113_112_255/0.12)] text-[#8a92ff] border-[rgb(113_112_255/0.22)] text-[10px] font-[510]"
                    >
                      {t.highlight}
                    </Badge>
                  )}
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="text-[24px] font-[590] tracking-[-0.48px] text-[#f7f8f8]">
                    {t.price}
                  </span>
                  {t.cadence && (
                    <span className="text-[12px] text-[#8a8f98]">{t.cadence}</span>
                  )}
                </div>
                <p className="text-[12px] text-[#8a8f98]">{t.blurb}</p>
                <ul className="space-y-2 pt-1">
                  {t.features.map((f) => (
                    <li key={f} className="flex items-start gap-1.5 text-[12.5px] text-[#d0d6e0]">
                      <Check className="mt-0.5 size-3 shrink-0 text-[#10b981]" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                {t.cta.external ? (
                  <a
                    href={t.cta.href}
                    className={`mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-[590] transition-colors ${
                      t.highlight
                        ? 'bg-[#7170ff] text-white hover:bg-[#8a92ff]'
                        : 'border border-[rgb(255_255_255/0.12)] text-[#d0d6e0] hover:border-[rgb(255_255_255/0.25)] hover:text-[#f7f8f8]'
                    }`}
                  >
                    {t.cta.label}
                  </a>
                ) : (
                  <Link
                    href={t.cta.href}
                    className={`mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-[590] transition-colors ${
                      t.highlight
                        ? 'bg-[#7170ff] text-white hover:bg-[#8a92ff]'
                        : 'border border-[rgb(255_255_255/0.12)] text-[#d0d6e0] hover:border-[rgb(255_255_255/0.25)] hover:text-[#f7f8f8]'
                    }`}
                  >
                    {t.cta.label}
                  </Link>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
        <p className="text-[11px] text-[#62666d]">
          Facilitators and agent marketplaces: partner pricing available —{' '}
          <a href="mailto:partners@agentkarma.io" className="underline underline-offset-2 hover:text-[#d0d6e0]">
            partners@agentkarma.io
          </a>
          .
        </p>
      </section>

      {/* Closing CTA */}
      <section className="rounded-lg border border-[rgb(113_112_255/0.20)] bg-gradient-to-br from-[rgb(113_112_255/0.06)] to-[rgb(113_112_255/0.02)] p-8 text-center">
        <h2 className="text-[22px] font-[590] tracking-[-0.264px] text-[#f7f8f8]">
          Ready to trust the agents you pay?
        </h2>
        <p className="mx-auto mt-2 max-w-xl text-[13px] text-[#8a8f98]">
          We'll set you up with a live fleet dashboard, sample disputes, and integration sketches in a
          30-minute call.
        </p>
        <a
          href="mailto:sales@agentkarma.io?subject=Karma%20Enterprise%20demo"
          className="mt-4 inline-flex items-center gap-2 rounded-md bg-[#7170ff] px-4 py-2 text-[13px] font-[590] text-white transition-colors hover:bg-[#8a92ff]"
        >
          Book a demo
          <ArrowRight className="size-3.5" />
        </a>
      </section>
    </div>
  );
}

function TrustStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-lg border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] px-4 py-3">
      <p className="text-[18px] font-[590] tabular-nums tracking-[-0.2px] text-[#f7f8f8]">{value}</p>
      <p className="mt-0.5 text-[10px] font-[510] uppercase tracking-[0.12em] text-[#62666d]">
        {label}
      </p>
    </div>
  );
}
