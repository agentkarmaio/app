/* Hallmark · macrostructure: Stat-Led · tone: technical-austere · anchor hue: indigo
 * theme: AK system (inherited from DESIGN.md) · anchor metaphor: NOTARY of agent succession
 * audience: builders + operators (forked) · use: Dead Man's Switch explainer
 *
 * Ships first, reads live-partial (Stellar witness live, multi-chain planned).
 * Cardinal spine on every section: AgentKarma witnesses, never holds.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, ArrowUpRight, Check } from 'lucide-react';
import {
  SectionHead,
  Stat,
  LiveFact,
} from '@/components/karma/section-head';
import { SuccessionTimelineChart } from '@/components/karma/succession-timeline-chart';

export const metadata: Metadata = {
  title: 'Agent Wills — the notary of agent succession',
  description:
    'An agent declares an heir and a heartbeat interval; AgentKarma derives the heartbeat from on-chain liveness and witnesses succession on-chain. Observe-only: we index the lifecycle, heirs act, we never hold funds.',
  alternates: { canonical: '/succession' },
};

// Roman-numeral spine — quiet orientation marks, never "01/FEATURES" eyebrows.
const SPINE = {
  what: 'I',
  derive: 'II',
  faces: 'III',
  estates: 'IV',
  rails: 'V',
} as const;

const SUCCESSION_FAQ = [
  {
    q: 'Does AgentKarma execute the will or move the inheritance?',
    a: 'No. Will-execution lives in an edge contract on-chain. AgentKarma indexes the lifecycle and turns it into a reputation signal. The heir acts; we witness.',
  },
  {
    q: 'Does declaring a will raise my score?',
    a: 'No. A declared will is a promise, not proof — it stays ⚪ Declared. The confidence badge only moves once heartbeats accrue and corroborate it.',
  },
  {
    q: 'Where does the heartbeat come from?',
    a: 'AgentKarma derives it from your existing on-chain liveness — the newest meaningful transaction on your wallet. No manual ping to AK, no extra integration. The chip flips purely from indexed activity.',
  },
  {
    q: 'Is the heartbeat double-counted into Autonomy?',
    a: 'No. The heartbeat feeds Karma durability only. Autonomy reads activity cadence on a separate axis. The same heartbeat is never counted into both.',
  },
];

export default function SuccessionPage() {
  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: SUCCESSION_FAQ.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };

  return (
    <div className="space-y-24">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />

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
          Agent Wills · Dead Man&apos;s Switch
        </p>
        <h1 className="text-[36px] font-[560] leading-[1.1] tracking-[-1px] text-[#f7f8f8] sm:text-[44px]">
          The notary of agent succession.
        </h1>
        <p className="max-w-2xl text-[15px] leading-relaxed text-[#8a8f98]">
          An agent declares an heir and a heartbeat interval. AgentKarma derives
          the heartbeat from on-chain liveness and witnesses every step — declared,
          alive, lapsed, inherited — as a reputation signal. Custody and execution
          live in edge contracts. We index the lifecycle; the heir acts; we never
          hold funds.
        </p>
        <div className="flex flex-wrap items-center gap-5 pt-1">
          <Link
            href="/estates"
            className="inline-flex items-center gap-1.5 text-[13px] font-[510] text-[#d0d6e0] transition-colors hover:text-[#f7f8f8]"
          >
            Browse Agent Estates
            <ArrowUpRight className="size-3.5" />
          </Link>
          <a
            href="#operators"
            className="inline-flex items-center gap-1.5 text-[13px] font-[510] text-[#8a8f98] transition-colors hover:text-[#d0d6e0]"
          >
            Set up succession
            <ArrowRight className="size-3.5" />
          </a>
        </div>
      </section>

      {/* ─────────── I · What it is ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker={SPINE.what}
          title="A heartbeat your wallet already sends."
          sub="Liveness you produce by simply operating becomes a portable durability signal. No new keys, no ping to us, no custody."
          accent="live-partial"
        />

        <div className="grid grid-cols-2 gap-x-8 gap-y-7 border-y border-[rgb(255_255_255/0.06)] py-7 sm:grid-cols-4">
          <Stat value="4" label="Chains ready" sub="Stellar leads" />
          <Stat value="1h–365d" label="Interval bounds" sub="operator-set" />
          <Stat value="Tier 2" label="Heartbeat signal" sub="behavior-inferred" />
          <Stat value="0" label="Funds held" sub="non-custody" />
        </div>

        <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
          <LiveFact title="Declare an heir + interval">
            Through the claim form&apos;s succession disclosure, or the self-hosted{' '}
            <span className="font-mono text-[#d0d6e0]">agentkarma.json</span>{' '}
            succession block. We store a commitment, never the heir address or
            any amount.
          </LiveFact>
          <LiveFact title="Witness, never hold">
            The will and its execution live in an edge contract you integrate
            separately. AgentKarma reads the on-chain lifecycle and nothing more.
          </LiveFact>
          <LiveFact title="Stellar leads, multi-chain ready">
            One <span className="font-mono text-[#d0d6e0]">agentkarma-settlement</span>{' '}
            witness serves the demo; the indexer is chain-agnostic across solana,
            celo, arc, and stellar.
          </LiveFact>
          <LiveFact title="Non-routing, non-custody">
            AK indexes, heirs act. We never proxy a call and never move an
            inheritance. Protocol-level MUST (RFC §12).
          </LiveFact>
        </div>
      </section>

      {/* ─────────── II · How AgentKarma derives it ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker={SPINE.derive}
          title="How AgentKarma derives it."
          sub="The lifecycle, observed on-chain and turned into signed signal at exact tiers."
          accent="live-partial"
        />

        <div className="rounded-xl border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.015)] p-6 sm:p-8">
          <SuccessionTimelineChart className="mx-auto max-w-2xl" />
        </div>

        <div className="grid gap-x-10 gap-y-3 md:grid-cols-2">
          <SignalRow
            name="will_declared"
            tier="Tier 3"
            sign="presence"
            note="A declared plan. Lifts tier-presence, not the badge."
          />
          <SignalRow
            name="heartbeat_observed"
            tier="Tier 2"
            sign="+"
            note="Liveness accrued. The corroboration that can move the badge."
          />
          <SignalRow
            name="heartbeat_lapsed"
            tier="Tier 2"
            sign="−"
            note="Missed check-in. Bounded haircut, capped at the Tier-2 ceiling — never zeroes."
          />
          <SignalRow
            name="inheritance_executed"
            tier="lifecycle"
            sign="heir acts"
            note="The heir acts in the edge contract. AK records the terminal state."
          />
        </div>

        <div className="space-y-3 rounded-lg border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.015)] p-5">
          <p className="text-[12.5px] leading-relaxed text-[#d0d6e0]">
            A declared will is a promise, not proof — the badge only moves once
            heartbeats accrue.
          </p>
          <p className="text-[12.5px] leading-relaxed text-[#8a8f98]">
            The heartbeat feeds Karma durability only. Autonomy reads activity
            cadence separately; the same heartbeat is never counted into both.
          </p>
        </div>
      </section>

      {/* ─────────── III · Two faces ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker={SPINE.faces}
          title="Two faces of succession."
          sub="The same lifecycle informs both faces of karma. Neither collapses into a single number."
          accent="live-partial"
        />

        <div className="grid gap-6 md:grid-cols-2">
          <FaceCard
            face="Provider face"
            title="Durability & handoff"
            body="A provider that stays alive — and has a clean handoff plan if it doesn't — is safer to route money to. Accrued heartbeats raise provider durability; a credible succession plan signals continuity."
          />
          <FaceCard
            face="Consumer face"
            title="Heir clean receipt"
            body="When inheritance executes, the heir inherits a clean receipt of the lineage. The consumer face reflects a well-formed handoff, never a silent disappearance."
          />
        </div>
      </section>

      {/* ─────────── IV · Agent Estates ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker={SPINE.estates}
          title="Agent Estates."
          sub="The public feed of agents whose heartbeat has lapsed — where heirs can act. AK indexes; heirs act."
          accent="live-partial"
        />

        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_280px]">
          <div className="space-y-3 rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.015)] p-6">
            <p className="text-[12.5px] leading-relaxed text-[#8a8f98]">
              Estates surfaces dormant agents, missed heartbeats, estates entered,
              and recoveries — stalest first, chain-filterable, Stellar-first. It
              is a witness feed, not an action surface: AgentKarma never executes a
              will. The heir acts in the edge contract.
            </p>
            <Link
              href="/estates"
              className="inline-flex items-center gap-1.5 pt-1 text-[12.5px] font-[510] text-[#d0d6e0] transition-colors hover:text-[#f7f8f8]"
            >
              Open Agent Estates
              <ArrowRight className="size-3" />
            </Link>
          </div>
          <div className="rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.015)] p-5">
            <p className="text-[10.5px] font-[510] uppercase tracking-[0.14em] text-[#62666d]">
              Non-routing callout
            </p>
            <p className="mt-3 text-[12.5px] leading-relaxed text-[#d0d6e0]">
              AK indexes, heirs act.
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-[#62666d]">
              No call is proxied, no inheritance is moved by AgentKarma. The estate
              feed is read-only.
            </p>
          </div>
        </div>
      </section>

      {/* ─────────── V · Audience rails ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker={SPINE.rails}
          title="Read it your way."
          sub="Builders read state and gate on it. Operators declare a plan in plain language. Neither writes funds to AgentKarma."
          accent="live-partial"
        />

        <div className="grid gap-6 md:grid-cols-2">
          {/* Builder rail */}
          <div id="builders" className="scroll-mt-24 space-y-3 rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.015)] p-6">
            <p className="text-[12px] font-[590] text-[#f7f8f8]">For builders</p>
            <ul className="space-y-2.5 text-[12px] leading-relaxed text-[#d0d6e0]">
              <RailItem>
                <span className="font-mono text-[11.5px] text-[#d0d6e0]">
                  ak.getKarma(wallet)
                </span>{' '}
                exposes{' '}
                <span className="font-mono text-[11.5px] text-[#d0d6e0]">
                  succession {'{'} status, lastHeartbeatAt, heir {'}'}
                </span>
                . No write path in AK.
              </RailItem>
              <RailItem>
                Gate with policy knobs on{' '}
                <span className="font-mono text-[11.5px] text-[#d0d6e0]">
                  evaluateTrust
                </span>{' '}
                —{' '}
                <span className="font-mono text-[11.5px] text-[#d0d6e0]">
                  rejectLapsed
                </span>
                ,{' '}
                <span className="font-mono text-[11.5px] text-[#d0d6e0]">
                  requireHeartbeat
                </span>
                . Read-only decision inputs.
              </RailItem>
              <RailItem>
                Or declare via the self-hosted{' '}
                <span className="font-mono text-[11.5px] text-[#d0d6e0]">
                  agentkarma.json
                </span>{' '}
                succession field. The will lives in the edge contract you
                integrate separately.
              </RailItem>
              <RailItem>
                Every signal carries an on-chain proof ref (the Stellar witness
                tx). Chips flip from indexed liveness — no manual ping to AK.
              </RailItem>
            </ul>
          </div>

          {/* Operator rail */}
          <div id="operators" className="scroll-mt-24 space-y-3 rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.015)] p-6">
            <p className="text-[12px] font-[590] text-[#f7f8f8]">
              For operators
            </p>
            <ul className="space-y-2.5 text-[12px] leading-relaxed text-[#d0d6e0]">
              <RailItem>
                Connect your wallet — the signature only proves ownership. It moves
                no funds.
              </RailItem>
              <RailItem>
                Set up succession in the claim form: an heir and a plain-language
                check-in interval. We store a commitment, never the heir address.
              </RailItem>
              <RailItem>
                Track your status in plain words — checking in normally, missed last
                check-in, or lapsed so the heir can act.
              </RailItem>
              <RailItem>
                Declaring a plan doesn&apos;t raise your score — staying alive does.
                The confidence badge stays put on a fresh declaration.
              </RailItem>
            </ul>
            <p className="border-t border-[rgb(255_255_255/0.06)] pt-3 text-[11px] leading-relaxed text-[#62666d]">
              AgentKarma never holds your funds and your heir acts, not us.
            </p>
          </div>
        </div>
      </section>

      {/* ─────────── FAQ ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker="VI"
          title="Questions"
          sub="Scoped to succession. The custody boundary, the badge rule, and the orthogonality guard."
          accent="live-partial"
        />
        <div className="divide-y divide-[rgb(255_255_255/0.06)] rounded-md border border-[rgb(255_255_255/0.06)]">
          {SUCCESSION_FAQ.map((item) => (
            <details key={item.q} className="group px-5 py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between text-[13px] font-[510] text-[#d0d6e0] transition-colors hover:text-[#f7f8f8]">
                {item.q}
                <ArrowRight className="size-3.5 shrink-0 text-[#62666d] transition-transform group-open:rotate-90" />
              </summary>
              <p className="mt-2.5 max-w-2xl text-[12.5px] leading-relaxed text-[#8a8f98]">
                {item.a}
              </p>
            </details>
          ))}
        </div>
      </section>

      {/* ─────────── CTA ─────────── */}
      <section className="space-y-5 border-t border-[rgb(255_255_255/0.06)] pt-8">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="space-y-1.5">
            <p className="text-[15px] font-[590] text-[#f7f8f8]">
              Give your agent a clean handoff.
            </p>
            <p className="text-[12.5px] leading-relaxed text-[#8a8f98]">
              Declare an heir and an interval. We&apos;ll witness the heartbeat;
              the rest stays in your contracts.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] sm:justify-end">
            <Link
              href="/estates"
              className="inline-flex items-center gap-1.5 font-[510] text-[#d0d6e0] transition-colors hover:text-[#f7f8f8]"
            >
              Agent Estates
              <ArrowUpRight className="size-3" />
            </Link>
            <Link
              href="/bonding"
              className="inline-flex items-center gap-1.5 font-[510] text-[#8a8f98] transition-colors hover:text-[#d0d6e0]"
            >
              Agent Bonding
              <ArrowRight className="size-3" />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ─────────────────────────── helpers ─────────────────────────── */

function SignalRow({
  name,
  tier,
  sign,
  note,
}: {
  name: string;
  tier: string;
  sign: string;
  note: string;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-[rgb(255_255_255/0.04)] py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[12px] text-[#d0d6e0]">{name}</span>
          <span className="rounded-full border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] px-1.5 py-0.5 text-[9.5px] font-[510] uppercase tracking-[0.1em] text-[#8a8f98]">
            {tier}
          </span>
          <span className="font-mono text-[11px] text-[#62666d]">· {sign}</span>
        </div>
        <p className="text-[11.5px] leading-relaxed text-[#62666d]">{note}</p>
      </div>
    </div>
  );
}

function FaceCard({
  face,
  title,
  body,
}: {
  face: string;
  title: string;
  body: string;
}) {
  return (
    <div className="space-y-2 rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.015)] p-6">
      <p className="text-[10.5px] font-[510] uppercase tracking-[0.14em] text-[#62666d]">
        {face}
      </p>
      <p className="text-[14px] font-[590] text-[#f7f8f8]">{title}</p>
      <p className="text-[12.5px] leading-relaxed text-[#8a8f98]">{body}</p>
    </div>
  );
}

function RailItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Check className="mt-0.5 size-3 shrink-0 text-[#10b981]" />
      <span>{children}</span>
    </li>
  );
}
