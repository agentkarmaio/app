/* Hallmark · macrostructure: Stat-Led · tone: technical-austere · anchor hue: indigo
 * theme: AK system (inherited from DESIGN.md) · enrichment: none
 * audience: technical partners · use: SDK install + validator partner email
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, ArrowUpRight, Check } from 'lucide-react';
import { CodeBlock } from '@/components/karma/code-block';
import { cachedStats } from '@/db/cached';

export const revalidate = 300;

export const metadata: Metadata = {
  title: 'Integrate — partner-grade reputation for autonomous agents',
  description:
    "What's live in @agentkarma/sdk today, the autonomy wedge no one else exposes, and the shipping roadmap. Built for x402 facilitators, marketplaces, lending, and infra teams.",
};

// Roman numerals for the section spine. Stat-Led uses them as quiet
// orientation marks, not "01 / FEATURES" eyebrows — those are banned.
const SPINE = {
  live: 'I',
  wedge: 'II',
  sdk: 'III',
  distribution: 'IV',
  roadmap: 'V',
} as const;

const SDK_QUICK_START = `import { createAgentKarmaClient, evaluateTrust } from '@agentkarma/sdk';

const ak = createAgentKarmaClient();

const snap = await ak.getKarma(agentWallet);
const decision = evaluateTrust(snap, {
  face: 'provider',
  minScore: 60,
  requireReceiptBacked: true,
  rejectAutonomyLabels: ['agent-like'], // gate human-only paths
});

if (!decision.allowed) {
  console.warn('rejected:', decision.reasons);
  return;
}
// proceed with your own service call. AgentKarma never proxies it.`;

const SDK_ROADMAP_SHAPE = `// Planned shape for evaluateTrust v0.2 (not shipped yet)
const decision = evaluateTrust(snap, { face: 'provider' });

decision.band;                     // 'high' | 'medium' | 'low' | 'unknown'
decision.recommendedFeeMultiplier; // e.g. 1.0 for high, 1.4 for low
decision.recommendedRateLimit;     // e.g. { rpm: 60 } for low-band
// Boolean gate still works; risk bands are additive.`;

export default async function IntegratePage() {
  const stats = await cachedStats().catch(() => null);

  // Numbers fall back to the values seen in production on 2026-06-10 if the
  // DB is briefly out. Honesty over freshness — never invent.
  const agents = stats?.totalAgents ?? 103_108;
  const txs = stats?.totalTransactions ?? 396_841;

  return (
    <div className="space-y-24">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" />
        Back to Leaderboard
      </Link>

      {/* ─────────── Headline ─────────── */}
      <section className="max-w-3xl space-y-5">
        <p className="text-[11px] font-[510] uppercase tracking-[0.16em] text-[#62666d]">
          Integrate
        </p>
        <h1 className="text-[36px] font-[560] leading-[1.1] tracking-[-1px] text-[#f7f8f8] sm:text-[44px]">
          The reputation layer your agent stack already needs.
        </h1>
        <p className="max-w-2xl text-[15px] leading-relaxed text-[#8a8f98]">
          AgentKarma scores every wallet with a public on-chain footprint and exposes
          the answer over a read-only SDK. No routing, no custody, no rev share on
          your payments. This page is the honest map of what ships today and what
          lands next.
        </p>
        <div className="flex flex-wrap items-center gap-5 pt-1">
          <a
            href="https://www.npmjs.com/package/@agentkarma/sdk"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[13px] font-[510] text-[#d0d6e0] transition-colors hover:text-[#f7f8f8]"
          >
            npm install @agentkarma/sdk
            <ArrowUpRight className="size-3.5" />
          </a>
          <a
            href="mailto:partners@agentkarma.io?subject=AgentKarma%20validator%20setup"
            className="inline-flex items-center gap-1.5 text-[13px] font-[510] text-[#8a8f98] transition-colors hover:text-[#d0d6e0]"
          >
            partners@agentkarma.io
            <ArrowRight className="size-3.5" />
          </a>
        </div>
      </section>

      {/* ─────────── I · Live today ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker={SPINE.live}
          title="Shipped, in production"
          sub="Real numbers, indexed continuously, queried over a public API."
          accent="live"
        />

        <div className="grid grid-cols-2 gap-x-8 gap-y-7 border-y border-[rgb(255_255_255/0.06)] py-7 sm:grid-cols-4">
          <Stat
            value={formatCount(agents)}
            label="Agents indexed"
            sub="Solana mainnet"
          />
          <Stat
            value={formatCount(txs)}
            label="x402 receipts"
            sub="Tier-1 signal"
          />
          <Stat value="2" label="Live chains" sub="Solana · Celo" />
          <Stat
            value="v0.1"
            label="SDK shipped"
            sub="@agentkarma/sdk"
          />
        </div>

        <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
          <LiveFact title="Two-faced karma">
            Every wallet carries{' '}
            <span className="font-mono text-[#d0d6e0]">provider</span> and{' '}
            <span className="font-mono text-[#d0d6e0]">consumer</span> scores. A
            marketplace gates one, a lender gates the other, neither collapses to
            a single number.
          </LiveFact>
          <LiveFact title="Confidence badges">
            Every score ships a badge — receipt-backed, behavior-inferred, or
            declared. Score without provenance is not a score.
          </LiveFact>
          <LiveFact title="ERC-8004 attestations">
            On Solana mainnet via the 8004-solana program, on Celo mainnet at
            agent <span className="font-mono text-[#d0d6e0]">#9058</span>. The
            score is the attestation, on-chain, portable.
          </LiveFact>
          <LiveFact title="MCP server">
            <span className="font-mono text-[#d0d6e0]">get_celo_agent</span> over
            streamable HTTP. An agent can read another agent&apos;s reputation
            without going through your code.
          </LiveFact>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-2 text-[11.5px] text-[#62666d]">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-1 rounded-full bg-[#10b981]" />
            Stellar chain in flight
          </span>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-1 rounded-full bg-[#10b981]" />
            Arc testnet registered as agentId{' '}
            <span className="font-mono text-[#8a8f98]">72077</span>
          </span>
        </div>
      </section>

      {/* ─────────── II · Autonomy wedge ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker={SPINE.wedge}
          title="Autonomy Confidence, separate axis from karma."
          sub="Nobody else surfaces this. Most reputation systems answer 'is this trustworthy'. AgentKarma also answers 'is this actually an agent', and lets you gate on either."
          accent="live"
        />

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-5">
            <p className="max-w-xl text-[13.5px] leading-relaxed text-[#d0d6e0]">
              A wallet&apos;s autonomy gets labelled{' '}
              <span className="font-mono text-[#f7f8f8]">agent-like</span>,{' '}
              <span className="font-mono text-[#f7f8f8]">mixed</span>,{' '}
              <span className="font-mono text-[#f7f8f8]">human-like</span>, or
              null. The label comes from cadence, off-hour activity, manifest
              signals, and self-verification via Self protocol on Celo. It rides
              the API as <span className="font-mono text-[#d0d6e0]">autonomy.label</span>,
              and the SDK lets you reject specific labels in one line.
            </p>
            <p className="text-[12.5px] leading-relaxed text-[#8a8f98]">
              Why it matters: a lending desk that wants to underwrite an agent and
              a marketplace that wants to keep humans out of an automated lane
              have opposite needs from the same number. Autonomy gives both.
            </p>
            <div className="flex flex-wrap gap-x-6 gap-y-3 pt-1">
              <Link
                href="/verify-self"
                className="inline-flex items-center gap-1.5 text-[12.5px] font-[510] text-[#d0d6e0] hover:text-[#f7f8f8] transition-colors"
              >
                Self-verification flow
                <ArrowRight className="size-3" />
              </Link>
              <a
                href="https://www.npmjs.com/package/@agentkarma/sdk"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[12.5px] font-[510] text-[#8a8f98] hover:text-[#d0d6e0] transition-colors"
              >
                SDK reference
                <ArrowUpRight className="size-3" />
              </a>
            </div>
          </div>

          <div className="rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.015)] p-5">
            <p className="text-[10.5px] font-[510] uppercase tracking-[0.14em] text-[#62666d]">
              API field
            </p>
            <p className="mt-3 font-mono text-[12px] text-[#d0d6e0]">
              autonomy: {'{'}
            </p>
            <p className="font-mono text-[12px] text-[#d0d6e0] pl-4">
              label: <span className="text-[#a3d6bd]">&apos;agent-like&apos;</span>,
            </p>
            <p className="font-mono text-[12px] text-[#d0d6e0] pl-4">
              score: <span className="text-[#b0b6f0]">0.82</span>,
            </p>
            <p className="font-mono text-[12px] text-[#d0d6e0] pl-4">
              evidence: [...]
            </p>
            <p className="font-mono text-[12px] text-[#d0d6e0]">{'}'}</p>
            <p className="mt-4 text-[11px] leading-relaxed text-[#62666d]">
              Returned on every wallet that crosses the evidence floor. Null
              otherwise, never guessed.
            </p>
          </div>
        </div>
      </section>

      {/* ─────────── III · Drop-in trust check ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker={SPINE.sdk}
          title="Drop-in trust check"
          sub="One pure function, eight typed knobs, no network on the policy step. Add it to any agent flow in ten minutes."
          accent="live"
        />

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
          <div className="space-y-3">
            <CodeBlock lang="ts">{SDK_QUICK_START}</CodeBlock>
            <p className="text-[11.5px] leading-relaxed text-[#62666d]">
              The SDK is zero-runtime-dependency, framework-agnostic (Node, Bun,
              Deno, browser, edge), and never signs or proxies anything. Pull the
              snapshot, evaluate locally, decide locally.
            </p>
          </div>

          <div className="space-y-4 rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.015)] p-5">
            <p className="text-[10.5px] font-[510] uppercase tracking-[0.14em] text-[#62666d]">
              What ships in v0.1
            </p>
            <ul className="space-y-2.5 text-[12px] leading-relaxed text-[#d0d6e0]">
              <ShippedItem>createAgentKarmaClient()</ShippedItem>
              <ShippedItem>getKarma · getProviderKarma · getConsumerKarma</ShippedItem>
              <ShippedItem>getCeloAgent(agentId)</ShippedItem>
              <ShippedItem>evaluateTrust (boolean gate)</ShippedItem>
              <ShippedItem>buildFeedbackMessage + submitFeedback</ShippedItem>
              <ShippedItem>Typed error tree (7 subclasses)</ShippedItem>
            </ul>
            <div className="border-t border-[rgb(255_255_255/0.06)] pt-3 text-[11.5px] text-[#62666d]">
              <span className="font-mono">@agentkarma/sdk@0.1</span> · MIT ·{' '}
              <a
                href="https://github.com/agentkarma"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#8a8f98] underline underline-offset-2 hover:text-[#d0d6e0]"
              >
                GitHub
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ─────────── IV · Distribution ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker={SPINE.distribution}
          title="Distribution that flows both ways."
          sub="Partners that attest to agents over AgentKarma's voluntary endpoint ride on every profile we index. Validator becomes co-marketing surface."
          accent="live-partial"
        />

        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-3 rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.015)] p-6">
            <p className="text-[12px] font-[590] text-[#f7f8f8]">For partners</p>
            <p className="text-[12.5px] leading-relaxed text-[#8a8f98]">
              Sign attestations through the AK validator endpoint and your brand
              appears as the source of truth on every agent profile we render.
              Karma score, partner logo, partner attestation count, all in one
              row. The partner is the source of weight, AK is the rail.
            </p>
            <ul className="space-y-1.5 pt-1 text-[12px] text-[#d0d6e0]">
              <li className="flex items-start gap-1.5">
                <Check className="mt-0.5 size-3 shrink-0 text-[#10b981]" />
                <span>Co-marketed across the index ({formatCount(agents)} profiles)</span>
              </li>
              <li className="flex items-start gap-1.5">
                <Check className="mt-0.5 size-3 shrink-0 text-[#10b981]" />
                <span>Validator endpoint spec lives in RFC v0.3</span>
              </li>
              <li className="flex items-start gap-1.5">
                <Check className="mt-0.5 size-3 shrink-0 text-[#10b981]" />
                <span>No tokenomics, no revenue share, no exclusivity</span>
              </li>
            </ul>
          </div>

          <div className="space-y-3 rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.015)] p-6">
            <div className="flex items-center justify-between">
              <p className="text-[12px] font-[590] text-[#f7f8f8]">Status</p>
              <PartialPill />
            </div>
            <p className="text-[12.5px] leading-relaxed text-[#8a8f98]">
              The attestation endpoint is reachable today over the API and is
              specced in <Link href="/protocol" className="underline underline-offset-2 hover:text-[#d0d6e0]">RFC v0.3</Link>.
              A typed SDK helper that wraps it (<span className="font-mono text-[#d0d6e0]">submitAttestation</span>)
              is the next thing to ship in <span className="font-mono text-[#d0d6e0]">@agentkarma/sdk</span>.
            </p>
            <p className="text-[12px] leading-relaxed text-[#62666d]">
              If you want to validate now and don&apos;t mind hand-rolling the POST,{' '}
              <a
                href="mailto:partners@agentkarma.io?subject=Validator%20onboarding"
                className="text-[#8a8f98] underline underline-offset-2 hover:text-[#d0d6e0]"
              >
                email partners@
              </a>{' '}
              and we&apos;ll wire it up the same week.
            </p>
          </div>
        </div>
      </section>

      {/* ─────────── V · Roadmap rail ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker={SPINE.roadmap}
          title="What's next"
          sub="Honest list. Pills mark anything not shipped. These are the three pieces partners ask for most; they're queued."
          accent="planned"
        />

        <div className="space-y-3 rounded-md border border-dashed border-[rgb(255_255_255/0.10)] bg-[rgb(255_255_255/0.01)] p-1">
          <RoadmapRow
            title="Trust Receipts"
            blurb="Cryptographically-signed audit logs partners store when they routed money to an agent. Proof of diligence at dispute time. The receipt carries the snapshot AK returned, the policy you evaluated, and the signature."
            target="Q3 2026"
            anchor="liability"
          />
          <RoadmapRow
            title="Risk-band pricing inputs"
            blurb="evaluateTrust extends from { allowed, reasons } to { band, recommendedFeeMultiplier, recommendedRateLimit }. Reputation becomes a pricing primitive for lending desks, x402 facilitators, and marketplaces."
            target="v0.2 — Q3 2026"
            anchor="pricing"
          />
          <RoadmapRow
            title="Webhooks + alerts"
            blurb="Subscribe to karma drops below a threshold, tier changes, confidence downgrades. Turns a one-time integration into an ops loop. Sketches in the RFC; infra not built."
            target="Q4 2026"
            anchor="webhooks"
          />
        </div>

        <div className="space-y-3 pt-2">
          <p className="text-[11.5px] font-[510] uppercase tracking-[0.14em] text-[#62666d]">
            Roadmap usage · pricing
          </p>
          <CodeBlock lang="ts">{SDK_ROADMAP_SHAPE}</CodeBlock>
          <p className="text-[11px] leading-relaxed text-[#62666d]">
            Shape is provisional until v0.2 lands. Show this to your team to scope
            the change; don&apos;t ship against it yet.
          </p>
        </div>
      </section>

      {/* ─────────── CTA ─────────── */}
      <section className="space-y-5 border-t border-[rgb(255_255_255/0.06)] pt-8">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="space-y-1.5">
            <p className="text-[15px] font-[590] text-[#f7f8f8]">
              Try it against a wallet you already know.
            </p>
            <p className="text-[12.5px] leading-relaxed text-[#8a8f98]">
              Install the SDK, point it at an agent you operate or one of your
              counterparties. If the answer surprises you, that&apos;s the signal.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] sm:justify-end">
            <a
              href="https://www.npmjs.com/package/@agentkarma/sdk"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 font-[510] text-[#d0d6e0] hover:text-[#f7f8f8] transition-colors"
            >
              npm
              <ArrowUpRight className="size-3" />
            </a>
            <a
              href="https://github.com/agentkarma"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 font-[510] text-[#8a8f98] hover:text-[#d0d6e0] transition-colors"
            >
              GitHub
              <ArrowUpRight className="size-3" />
            </a>
            <a
              href="mailto:partners@agentkarma.io?subject=AgentKarma%20integration"
              className="inline-flex items-center gap-1.5 font-[510] text-[#8a8f98] hover:text-[#d0d6e0] transition-colors"
            >
              partners@agentkarma.io
              <ArrowRight className="size-3" />
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ─────────────────────────── helpers ─────────────────────────── */

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return n.toLocaleString('en-US');
}

function SectionHead({
  marker,
  title,
  sub,
  accent,
}: {
  marker: string;
  title: string;
  sub: string;
  accent: 'live' | 'live-partial' | 'planned';
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="font-mono text-[11px] tracking-[0.04em] text-[#4f5258]">
          {marker}
        </span>
        <span aria-hidden className="h-px flex-1 bg-[rgb(255_255_255/0.06)]" />
        <StatusPill accent={accent} />
      </div>
      <h2 className="max-w-2xl text-[22px] font-[590] leading-[1.2] tracking-[-0.4px] text-[#f7f8f8] sm:text-[24px]">
        {title}
      </h2>
      <p className="max-w-2xl text-[13px] leading-relaxed text-[#8a8f98]">{sub}</p>
    </div>
  );
}

function StatusPill({ accent }: { accent: 'live' | 'live-partial' | 'planned' }) {
  if (accent === 'live') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[rgb(16_185_129/0.20)] bg-[rgb(16_185_129/0.08)] px-2 py-0.5 text-[10px] font-[510] uppercase tracking-[0.12em] text-[#a3d6bd]">
        <span aria-hidden className="size-1 rounded-full bg-[#10b981]" />
        Live
      </span>
    );
  }
  if (accent === 'live-partial') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[rgb(234_179_8/0.20)] bg-[rgb(234_179_8/0.06)] px-2 py-0.5 text-[10px] font-[510] uppercase tracking-[0.12em] text-[#e0c879]">
        <span aria-hidden className="size-1 rounded-full bg-[#eab308]" />
        API live · SDK pending
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] px-2 py-0.5 text-[10px] font-[510] uppercase tracking-[0.12em] text-[#8a8f98]">
      <span aria-hidden className="size-1 rounded-full bg-[#62666d]" />
      Planned
    </span>
  );
}

function PartialPill() {
  return <StatusPill accent="live-partial" />;
}

function Stat({
  value,
  label,
  sub,
}: {
  value: string;
  label: string;
  sub: string;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[24px] font-[560] tabular-nums tracking-[-0.4px] text-[#f7f8f8] sm:text-[26px]">
        {value}
      </p>
      <p className="text-[10.5px] font-[510] uppercase tracking-[0.14em] text-[#8a8f98]">
        {label}
      </p>
      <p className="text-[10.5px] text-[#62666d]">{sub}</p>
    </div>
  );
}

function LiveFact({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[13px] font-[590] text-[#f7f8f8]">{title}</p>
      <p className="text-[12.5px] leading-relaxed text-[#8a8f98]">{children}</p>
    </div>
  );
}

function ShippedItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Check className="mt-0.5 size-3 shrink-0 text-[#10b981]" />
      <span className="font-mono text-[11.5px] text-[#d0d6e0]">{children}</span>
    </li>
  );
}

function RoadmapRow({
  title,
  blurb,
  target,
  anchor,
}: {
  title: string;
  blurb: string;
  target: string;
  anchor: string;
}) {
  return (
    <div
      id={anchor}
      className="grid gap-3 rounded-md p-5 sm:grid-cols-[minmax(0,1fr)_180px] sm:gap-6 hover:bg-[rgb(255_255_255/0.02)] transition-colors"
    >
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <p className="text-[13.5px] font-[590] text-[#f7f8f8]">{title}</p>
          <StatusPill accent="planned" />
        </div>
        <p className="text-[12.5px] leading-relaxed text-[#8a8f98]">{blurb}</p>
      </div>
      <div className="space-y-1 sm:text-right">
        <p className="text-[10.5px] font-[510] uppercase tracking-[0.14em] text-[#62666d]">
          Target
        </p>
        <p className="font-mono text-[12px] text-[#d0d6e0]">{target}</p>
      </div>
    </div>
  );
}
