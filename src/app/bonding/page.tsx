/* Hallmark · macrostructure: Stat-Led · tone: technical-austere · anchor hue: indigo
 * theme: AK system (inherited from DESIGN.md) · anchor metaphor: LLOYD'S of London
 * audience: builders + sureties/operators (forked) · use: Agent Bonding explainer
 *
 * GATED: whole page headed by a planned·contingent pill until founder sign-off
 * on SIGNAL-ARCHITECTURE.md:234. Distinct section cadence from /succession —
 * NOT a find-replace. Hero proof = the cardinal-rule live demo.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, ArrowUpRight, Check } from 'lucide-react';
import {
  SectionHead,
  StatusPill,
  Stat,
  LiveFact,
} from '@/components/karma/section-head';
import { CardinalRuleDemo } from '@/components/karma/cardinal-rule-demo';

export const metadata: Metadata = {
  title: 'Agent Bonding — Lloyd’s of London for autonomous agents',
  description:
    'A third party stakes USDC in an edge escrow vouching a young agent will deliver. AgentKarma witnesses the bond lifecycle as a Tier-1 vouched-capacity signal. We witness the bond, never hold the funds. A bond lifts the confidence badge, never the trust-tier ceiling.',
  alternates: { canonical: '/bonding' },
};

const SPINE = {
  cardinal: 'I',
  lloyds: 'II',
  surety: 'III',
  rails: 'IV',
} as const;

const BONDING_FAQ = [
  {
    q: 'Does AgentKarma hold or move the staked funds?',
    a: 'No. The stake lives in an edge escrow contract on-chain. AgentKarma witnesses the bond lifecycle and reads it as reputation. We never create, hold, or release a bond.',
  },
  {
    q: 'Can an agent buy its way to a high tier with a bond?',
    a: 'No. This is the cardinal rule. A bond lifts the confidence badge and tier-presence — never the evidence-gated trust-tier ceiling. A thin-file agent never reaches Excellent on borrowed capital.',
  },
  {
    q: 'Is Surety Karma blended into the agent’s score?',
    a: 'No. Surety Karma is its own orthogonal axis, shown alongside Karma via its own chip, never folded into Provider or Consumer karma.',
  },
];

export default function BondingPage() {
  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: BONDING_FAQ.map((item) => ({
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
        <div className="flex items-center gap-3">
          <p className="text-[11px] font-[510] uppercase tracking-[0.16em] text-[#62666d]">
            Agent Bonding
          </p>
          <StatusPill accent="contingent" />
        </div>
        <h1 className="text-[36px] font-[560] leading-[1.1] tracking-[-1px] text-[#f7f8f8] sm:text-[44px]">
          Vouch for an agent. We witness the bond, never hold the funds.
        </h1>
        <p className="max-w-2xl text-[15px] leading-relaxed text-[#8a8f98]">
          A third party stakes USDC in an edge escrow vouching that a young agent
          will deliver. AgentKarma reads the bond lifecycle as a Tier-1
          vouched-capacity signal. Lloyd&apos;s of London for autonomous agents —
          underwriters carry the risk, the coffeehouse keeps the ledger.
        </p>
        <div className="rounded-md border border-[rgb(234_179_8/0.18)] bg-[rgb(234_179_8/0.04)] px-4 py-3 text-[12px] leading-relaxed text-[#e0c879]">
          This feature is built and waiting on a founder sign-off. Surfaces are
          shown honestly as <span className="font-[590]">planned · contingent</span>{' '}
          until then. Succession ships standalone today.
        </div>
      </section>

      {/* ─────────── I · Cardinal rule, proven on screen ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker={SPINE.cardinal}
          title="A bond lifts confidence, never the ceiling."
          sub="The cardinal rule, proven on screen rather than in a paragraph: the confidence badge flips 🟡 → 🟢 on bond_resolved while the trust-tier ceiling stays visibly pinned."
          accent="contingent"
        />

        <div className="grid gap-8 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
          <CardinalRuleDemo />
          <div className="space-y-5">
            <p className="max-w-xl text-[13.5px] leading-relaxed text-[#d0d6e0]">
              A resolved bond is a Tier-1 receipt: a sponsor put real capital behind
              the agent and the beneficiary acknowledged delivery on-chain. That
              moves the confidence badge to 🟢 receipt-backed.
            </p>
            <p className="max-w-xl text-[12.5px] leading-relaxed text-[#8a8f98]">
              What it never does is move the evidence-gated trust-tier ceiling. An
              agent with a thin file stays capped no matter how large the bond.
              Reputation can be vouched for, but it cannot be bought.
            </p>
            <p className="text-[11.5px] leading-relaxed text-[#62666d]">
              Custody boundary: the stake never touches AgentKarma. It rests in the
              edge escrow until the beneficiary acknowledges delivery, or the
              deadline lapses, and resolves it. We index the result.
            </p>
          </div>
        </div>
      </section>

      {/* ─────────── II · Lloyd's mechanics ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker={SPINE.lloyds}
          title="The coffeehouse, not the bank."
          sub="Underwriters compete to back agents they believe in. AgentKarma keeps the ledger of who vouched, who delivered, and who got burned — it never takes the other side of the bet."
          accent="contingent"
        />

        <div className="grid grid-cols-2 gap-x-8 gap-y-7 border-y border-[rgb(255_255_255/0.06)] py-7 sm:grid-cols-4">
          <Stat value="Tier 1" label="Bond signal" sub="vouched-capacity" />
          <Stat value="USDC" label="Stake currency" sub="edge escrow" />
          <Stat value="4" label="Chains ready" sub="Stellar leads" />
          <Stat value="0" label="Funds held by AK" sub="non-custody" />
        </div>

        <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
          <LiveFact title="bond_opened">
            A surety stakes USDC in the edge escrow for a named agent and task.
            AgentKarma records the open as a Tier-1 vouched-capacity signal —
            presence only, never a ceiling lift.
          </LiveFact>
          <LiveFact title="bond_resolved">
            When the beneficiary acknowledges delivery the underwriters are refunded;
            on a missed deadline the pooled stake pays the beneficiary. Either way AK
            reads the terminal state and flips the confidence badge accordingly.
          </LiveFact>
          <LiveFact title="Ownerless escrow">
            The escrow has no admin and no AgentKarma key. Success is authorized by
            the beneficiary (who would otherwise collect the pool), failure is
            permissionless after the deadline. AK does not attest the outcome — it
            witnesses it. (Preview: contract authored, demo-only, not deployed.)
          </LiveFact>
          <LiveFact title="Demo data is labelled">
            Until a live escrow source lands, any bond shown is seeded demo data,
            flagged <span className="font-mono text-[#d0d6e0]">is_demo</span> and
            visibly marked. No real counterparties.
          </LiveFact>
        </div>
      </section>

      {/* ─────────── III · Surety Karma, its own axis ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker={SPINE.surety}
          title="Surety Karma is its own axis."
          sub="An underwriter builds a track record of good calls. That is reputation in its own right — orthogonal to the agent's Karma and to Autonomy, never blended in."
          accent="contingent"
        />

        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-3 rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.015)] p-6">
            <p className="text-[12.5px] leading-relaxed text-[#8a8f98]">
              A surety&apos;s settled bonds, success rate, and in-flight exposure
              compute a Surety Karma carried on its own chip. A marketplace can gate
              on the agent&apos;s Karma, the agent&apos;s bond coverage, and the
              backer&apos;s Surety Karma as three independent inputs. None of them
              collapses into another.
            </p>
            <p className="text-[12px] leading-relaxed text-[#62666d]">
              Two-faced karma still holds: the bond feeds the agent&apos;s Provider
              face as vouched-capacity, while Surety Karma sits beside it as a
              separate axis.
            </p>
          </div>
          <div className="space-y-2.5 rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.015)] p-5">
            <p className="text-[10.5px] font-[510] uppercase tracking-[0.14em] text-[#62666d]">
              Three independent axes
            </p>
            <AxisChip label="Karma" hue="#7170ff" note="provider · consumer" />
            <AxisChip label="Autonomy" hue="#10b981" note="agent cadence" />
            <AxisChip label="Surety Karma" hue="#f5a623" note="underwriter record" />
            <p className="pt-1 text-[11px] leading-relaxed text-[#62666d]">
              Shown side by side, never folded together.
            </p>
          </div>
        </div>
      </section>

      {/* ─────────── IV · Audience rails ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker={SPINE.rails}
          title="Read it your way."
          sub="Builders read bond state and gate on it. Sureties open bonds with an escrow partner — never with AgentKarma."
          accent="contingent"
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
                  bond {'{'} status, coveragePct, suretyWallet, expiresAt {'}'}
                </span>
                . Read-only — no write path in AK.
              </RailItem>
              <RailItem>
                Gate with{' '}
                <span className="font-mono text-[11.5px] text-[#d0d6e0]">
                  requireBonded
                </span>{' '}
                and{' '}
                <span className="font-mono text-[11.5px] text-[#d0d6e0]">
                  minCoverage
                </span>{' '}
                on{' '}
                <span className="font-mono text-[11.5px] text-[#d0d6e0]">
                  evaluateTrust
                </span>{' '}
                — read-only decision inputs.
              </RailItem>
              <RailItem>
                Every bond exposes its on-chain proof ref. Chips flip from indexed
                lifecycle, never a manual ping to AK.
              </RailItem>
            </ul>
          </div>

          {/* Surety rail */}
          <div id="operators" className="scroll-mt-24 space-y-3 rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.015)] p-6">
            <p className="text-[12px] font-[590] text-[#f7f8f8]">
              For sureties &amp; operators
            </p>
            <ul className="space-y-2.5 text-[12px] leading-relaxed text-[#d0d6e0]">
              <RailItem>
                Connect your wallet — the signature only proves ownership and moves
                no funds.
              </RailItem>
              <RailItem>
                You&apos;ll open the bond with an edge-escrow partner. AgentKarma
                never holds or moves your stake; we witness it on-chain. There is no
                &ldquo;create bond&rdquo; button in AK.
              </RailItem>
              <RailItem>
                Track your underwriting record and Surety Karma as it accrues from
                resolved bonds.
              </RailItem>
            </ul>
            <p className="border-t border-[rgb(255_255_255/0.06)] pt-3 text-[11px] leading-relaxed text-[#62666d]">
              We witness, we never hold.
            </p>
          </div>
        </div>
      </section>

      {/* ─────────── FAQ ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker="V"
          title="Questions"
          sub="Scoped to bonding. Custody, the cardinal rule, and the orthogonality of Surety Karma."
          accent="contingent"
        />
        <div className="divide-y divide-[rgb(255_255_255/0.06)] rounded-md border border-[rgb(255_255_255/0.06)]">
          {BONDING_FAQ.map((item) => (
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
              Built and waiting on sign-off.
            </p>
            <p className="text-[12.5px] leading-relaxed text-[#8a8f98]">
              Bonding ships once the signal-architecture decision lands; it runs on
              demo data today. Succession is live across all chains.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] sm:justify-end">
            <Link
              href="/succession"
              className="inline-flex items-center gap-1.5 font-[510] text-[#d0d6e0] transition-colors hover:text-[#f7f8f8]"
            >
              Agent Wills
              <ArrowUpRight className="size-3" />
            </Link>
            <Link
              href="/integrate"
              className="inline-flex items-center gap-1.5 font-[510] text-[#8a8f98] transition-colors hover:text-[#d0d6e0]"
            >
              Integrate the SDK
              <ArrowRight className="size-3" />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ─────────────────────────── helpers ─────────────────────────── */

function AxisChip({
  label,
  hue,
  note,
}: {
  label: string;
  hue: string;
  note: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: hue }} />
      <span className="text-[12px] font-[510] text-[#d0d6e0]">{label}</span>
      <span className="text-[11px] text-[#62666d]">{note}</span>
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
