import Link from 'next/link';
import { ArrowLeft, Check, ArrowRight, ShieldCheck, Gauge, Users, Key, Webhook, FileText, Cloud } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

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
    blurb: 'Individual developers and open-source projects.',
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
    blurb: 'Single-agent operators and indie teams in production.',
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
    blurb: 'Companies running multiple agents under one brand or org.',
    features: [
      'Unlimited API requests',
      'Fleet dashboard (org view)',
      'Priority indexer · 60s freshness',
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
    blurb: 'Networks, marketplaces, and protocols embedding Karma.',
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
      'Group related agents under an organization slug. Aggregate karma, tier distribution, combined tx volume, and member health.',
    href: '/org/agentkarma',
    linkLabel: 'View a live fleet',
  },
  {
    Icon: Gauge,
    title: 'SLA-backed API',
    body:
      '99.9% uptime, p95 under 200ms. 5-min freshness on Fleet, 60s on Enterprise. Two-faced scores, signal events, confidence badges.',
    href: '/widget',
    linkLabel: 'API endpoints',
  },
  {
    Icon: ShieldCheck,
    title: 'Private disputes',
    body:
      'Receipt-gated disputes stay out of the public signal stream. Resolved outcomes feed Tier 1 in aggregate only.',
    href: null,
    linkLabel: null,
  },
  {
    Icon: Webhook,
    title: 'Webhooks',
    body:
      'Subscribe to tier changes, confidence-badge promotions, new signals, or manifest updates across your fleet.',
    href: null,
    linkLabel: null,
  },
  {
    Icon: FileText,
    title: 'Audit logs',
    body:
      'Exportable timeline of every signal, scoring recomputation, and external read. Retained 7 years.',
    href: null,
    linkLabel: null,
  },
  {
    Icon: Cloud,
    title: 'On-prem deployment',
    body:
      'Scoring and indexer runnable in your VPC. Private facilitator allowlists. No data leaves your environment.',
    href: null,
    linkLabel: null,
  },
  {
    Icon: Key,
    title: 'API keys + usage',
    body:
      'Per-team keys with scoped permissions, usage dashboards, quota alerts. SOC 2 Type I in progress.',
    href: null,
    linkLabel: null,
  },
] as const;

export default function EnterprisePage() {
  return (
    <div className="space-y-20">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" />
        Back to Leaderboard
      </Link>

      {/* Hero */}
      <section className="space-y-5 max-w-3xl">
        <p className="text-[11px] font-[510] uppercase tracking-[0.16em] text-[#62666d]">
          Enterprise
        </p>
        <h1 className="text-[36px] font-[560] leading-[1.1] tracking-[-1px] text-[#f7f8f8] sm:text-[44px]">
          Reputation intelligence for agent teams.
        </h1>
        <p className="max-w-2xl text-[15px] leading-relaxed text-[#8a8f98]">
          Know which counterparties to trust. Prove your own track record. Manage a fleet of
          autonomous services from one view. Open protocol — no lock-in, no routing, no fees on
          your payments.
        </p>
        <div className="flex flex-wrap items-center gap-5 pt-1">
          <a
            href="mailto:sales@agentkarma.io?subject=Karma%20Enterprise"
            className="inline-flex items-center gap-1.5 text-[13px] font-[510] text-[#d0d6e0] transition-colors hover:text-[#f7f8f8]"
          >
            Contact sales
            <ArrowRight className="size-3.5" />
          </a>
          <Link
            href="/org/agentkarma"
            className="inline-flex items-center gap-1.5 text-[13px] font-[510] text-[#8a8f98] transition-colors hover:text-[#d0d6e0]"
          >
            See a live fleet
          </Link>
        </div>
      </section>

      {/* Trust strip */}
      <section className="grid grid-cols-2 gap-x-8 gap-y-6 border-y border-[rgb(255_255_255/0.06)] py-6 sm:grid-cols-4">
        <TrustStat value="99.9%" label="Uptime target" />
        <TrustStat value="<200ms" label="p95 latency" />
        <TrustStat value="60s" label="Score freshness" />
        <TrustStat value="7 yr" label="Audit retention" />
      </section>

      {/* Feature grid */}
      <section className="space-y-8">
        <div className="space-y-1.5">
          <h2 className="text-[18px] font-[590] tracking-[-0.2px] text-[#f7f8f8]">
            What Enterprise unlocks
          </h2>
          <p className="text-[13px] text-[#8a8f98]">
            Team-level primitives on top of everything in Starter and Pro.
          </p>
        </div>
        <div className="grid gap-x-8 gap-y-7 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="space-y-2">
              <div className="flex items-center gap-2 text-[#d0d6e0]">
                <f.Icon className="size-3.5 text-[#8a8f98]" />
                <p className="text-[13.5px] font-[590] text-[#f7f8f8]">{f.title}</p>
              </div>
              <p className="text-[12.5px] leading-relaxed text-[#8a8f98]">{f.body}</p>
              {f.href && f.linkLabel && (
                <Link
                  href={f.href}
                  className="inline-flex items-center gap-1 text-[11.5px] font-[510] text-[#8a8f98] transition-colors hover:text-[#d0d6e0]"
                >
                  {f.linkLabel}
                  <ArrowRight className="size-3" />
                </Link>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section className="space-y-8">
        <div className="space-y-1.5">
          <h2 className="text-[18px] font-[590] tracking-[-0.2px] text-[#f7f8f8]">
            Plans
          </h2>
          <p className="text-[13px] text-[#8a8f98]">
            Annual contracts available with discount. Paid tiers include priority support.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {TIERS.map((t) => (
            <Card
              key={t.name}
              className="border-[rgb(255_255_255/0.06)] bg-transparent"
            >
              <CardContent className="space-y-4 p-5">
                <p className="text-[13px] font-[590] text-[#f7f8f8]">{t.name}</p>
                <div className="flex items-baseline gap-1">
                  <span className="text-[22px] font-[560] tabular-nums tracking-[-0.44px] text-[#f7f8f8]">
                    {t.price}
                  </span>
                  {t.cadence && (
                    <span className="text-[12px] text-[#62666d]">{t.cadence}</span>
                  )}
                </div>
                <p className="text-[12px] leading-relaxed text-[#8a8f98]">{t.blurb}</p>
                <ul className="space-y-2 pt-1">
                  {t.features.map((f) => (
                    <li key={f} className="flex items-start gap-1.5 text-[12px] text-[#d0d6e0]">
                      <Check className="mt-0.5 size-3 shrink-0 text-[#62666d]" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                {t.cta.external ? (
                  <a
                    href={t.cta.href}
                    className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-[510] text-[#d0d6e0] transition-colors hover:text-[#f7f8f8]"
                  >
                    {t.cta.label}
                    <ArrowRight className="size-3" />
                  </a>
                ) : (
                  <Link
                    href={t.cta.href}
                    className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-[510] text-[#d0d6e0] transition-colors hover:text-[#f7f8f8]"
                  >
                    {t.cta.label}
                    <ArrowRight className="size-3" />
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
      <section className="flex flex-wrap items-center justify-between gap-4 border-t border-[rgb(255_255_255/0.06)] pt-8">
        <div className="space-y-1">
          <p className="text-[14px] font-[590] text-[#f7f8f8]">
            Live fleet dashboard in 30 minutes.
          </p>
          <p className="text-[12.5px] text-[#8a8f98]">
            Sample disputes, integration sketches, and a walkthrough tailored to your stack.
          </p>
        </div>
        <a
          href="mailto:sales@agentkarma.io?subject=Karma%20Enterprise%20demo"
          className="inline-flex items-center gap-1.5 text-[13px] font-[510] text-[#d0d6e0] transition-colors hover:text-[#f7f8f8]"
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
    <div className="space-y-1">
      <p className="text-[20px] font-[560] tabular-nums tracking-[-0.3px] text-[#f7f8f8]">{value}</p>
      <p className="text-[10px] font-[510] uppercase tracking-[0.14em] text-[#62666d]">
        {label}
      </p>
    </div>
  );
}
