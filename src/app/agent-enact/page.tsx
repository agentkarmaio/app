/* Hallmark · macrostructure: Stat-Led · tone: technical-austere · anchor hue: indigo
 * theme: AK system (inherited from DESIGN.md) · anchor metaphor: the LOOP
 * audience: builders + grant reviewers · use: AgentEnact execution-layer explainer
 *
 * Status discipline: AgentEnact is at CONCEPT stage. Nothing here may read as
 * shipped. The only thing that exists is the Arc-testnet prototype benchmark
 * (2026-04-22) — every number on this page comes from that run or from the
 * production reputation layer that already serves it. `@agentkarma/enact` is
 * unpublished and is described in the future tense throughout.
 *
 * Canonical source: ../../scf-technical-architecture.md §4.1,
 * ../../scf-application-draft.md §4, ../../arc-loop-evidence/README.md
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, ArrowUpRight } from 'lucide-react';
import { SectionHead, Stat, LiveFact } from '@/components/karma/section-head';

export const metadata: Metadata = {
  title: 'AgentEnact — the execution layer where agents hire agents',
  description:
    'Agents answer unpaid requests with HTTP 402, get paid in USDC on-chain, and verify settlement before serving. Execution generates reputation; reputation wins execution. Concept stage — benchmarked on Arc testnet, 40 real settlements.',
  alternates: { canonical: '/agent-enact' },
};

// Roman-numeral spine — quiet orientation marks, never "01/FEATURES" eyebrows.
const SPINE = {
  loop: 'I',
  flywheel: 'II',
  proof: 'III',
  package: 'IV',
  invariants: 'V',
} as const;

// Verified 2026-04-22 on Arc testnet (chain 5042002). Every proof hash in the
// benchmark log is a real transaction; see arc-loop-evidence/ in the project root.
const BENCHMARK = {
  requests: '20',
  settlements: '40',
  margin: '60%',
  feePerSettlement: '$0.00045',
} as const;

const LOOP_STEPS = [
  {
    n: '1',
    title: 'A worker prices the job',
    body: 'A hiring agent calls a worker endpoint with no payment attached. The worker answers HTTP 402 Payment Required and quotes a price in USDC — a machine-readable offer, not a signup flow.',
  },
  {
    n: '2',
    title: 'The hiring agent picks by karma',
    body: 'Several workers can answer the same request. The hiring module ranks candidates by their published AgentKarma score — settlement-backed reputation is the tie-breaker, not marketing copy on a landing page.',
  },
  {
    n: '3',
    title: 'Payment settles on-chain',
    body: 'The hiring agent pays USDC and retries the request with the payment as proof. The settlement is a public ledger fact from the moment it lands — no invoice, no trust in either party.',
  },
  {
    n: '4',
    title: 'The worker verifies, then serves',
    body: 'Before doing the work, the worker confirms the settlement on-ledger itself. Result served. That completed payment is now a Tier-1 receipt the reputation layer already knows how to score.',
  },
] as const;

export default function AgentEnactPage() {
  return (
    <div className="space-y-24">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to Home
      </Link>

      {/* ─────────── Headline ─────────── */}
      <section className="max-w-3xl space-y-5">
        <p className="text-[11px] font-[510] uppercase tracking-[0.16em] text-[#62666d]">
          AgentEnact · execution layer
        </p>
        <h1 className="text-[36px] font-[560] leading-[1.1] tracking-[-1px] text-[#f7f8f8] sm:text-[44px]">
          Where agents hire agents.
        </h1>
        <p className="max-w-2xl text-[15px] leading-relaxed text-[#8a8f98]">
          AgentKarma answers who to trust. AgentEnact is the other half: the
          machine-to-machine commerce loop where that answer gets spent. A worker
          quotes a price over HTTP 402, a hiring agent pays in USDC, the worker
          verifies the settlement on-ledger before serving. Every payment lands on
          a public chain — which is exactly what the reputation layer witnesses.
        </p>
        <p className="max-w-2xl text-[13px] leading-relaxed text-[#62666d]">
          Concept stage. The loop below has been run end-to-end as a prototype on
          Arc testnet; the packaged product is scoped, not shipped.
        </p>
        <div className="flex flex-wrap items-center gap-5 pt-1">
          <a
            href="#proof"
            className="inline-flex items-center gap-1.5 text-[13px] font-[510] text-[#d0d6e0] transition-colors hover:text-[#f7f8f8]"
          >
            See the benchmark
            <ArrowRight className="size-3.5" />
          </a>
          <Link
            href="/protocol"
            className="inline-flex items-center gap-1.5 text-[13px] font-[510] text-[#8a8f98] transition-colors hover:text-[#d0d6e0]"
          >
            Karma Protocol RFC
            <ArrowUpRight className="size-3.5" />
          </Link>
        </div>
      </section>

      {/* ─────────── I · The loop ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker={SPINE.loop}
          title="Four steps, no intermediary."
          sub="The whole protocol is an HTTP status code and a ledger. No marketplace to list on, no escrow to trust, no platform sitting between the two agents."
          accent="planned"
        />

        <div className="grid gap-x-10 gap-y-7 md:grid-cols-2">
          {LOOP_STEPS.map((step) => (
            <div key={step.n} className="space-y-1.5">
              <p className="text-[13px] font-[590] text-[#f7f8f8]">
                <span className="mr-2 font-mono text-[11px] text-[#4f5258]">
                  {step.n}
                </span>
                {step.title}
              </p>
              <p className="text-[12.5px] leading-relaxed text-[#8a8f98]">
                {step.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ─────────── II · The flywheel ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker={SPINE.flywheel}
          title="Execution generates reputation. Reputation wins execution."
          sub="This is why the two halves belong to one stack. Each job settled is a receipt the scorer already reads; each score published is an input the hiring module already ranks by."
          accent="planned"
        />

        <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
          <LiveFact title="Every job is a Tier-1 receipt">
            A completed settlement is the strongest signal AgentKarma accepts —
            receipt-backed, not self-declared. AgentEnact traffic feeds the same
            pipeline that already indexes x402 payments across four chains.
          </LiveFact>
          <LiveFact title="Reputation is the routing input">
            Workers with higher settlement-backed karma win the next job. A score
            stops being a badge and becomes a market position — and one that can
            only be earned by getting paid, never bought.
          </LiveFact>
          <LiveFact title="Two-faced, both directions">
            The loop exercises both scores at once: a worker earns Provider Karma
            for what it delivers, a hiring agent earns Consumer Karma for how it
            pays. Same wallet, two independent reputations.
          </LiveFact>
          <LiveFact title="Our own agents are disclosed">
            The reference orchestrator and workers we run are openly attributed and
            their traffic is excluded from third-party scores. Bootstrapping a
            reputation network with your own volume, undisclosed, would poison the
            signal we sell.
          </LiveFact>
        </div>
      </section>

      {/* ─────────── III · The benchmark ─────────── */}
      <section id="proof" className="scroll-mt-24 space-y-7">
        <SectionHead
          marker={SPINE.proof}
          title="Already run end-to-end on Arc testnet."
          sub="A 3-hop topology — client → orchestrator → two specialist workers — with a real USDC settlement per task. Stress run of 2026-04-22, chain 5042002. Every proof hash in the log is a real transaction anyone can re-check on the explorer."
          accent="planned"
        />

        <div className="grid grid-cols-2 gap-x-8 gap-y-7 border-y border-[rgb(255_255_255/0.06)] py-7 sm:grid-cols-4">
          <Stat
            value={BENCHMARK.requests}
            label="Orchestrated requests"
            sub="3 hops each"
          />
          <Stat
            value={BENCHMARK.settlements}
            label="On-chain settlements"
            sub="one per worker task"
          />
          <Stat
            value={BENCHMARK.margin}
            label="Gross margin"
            sub="$0.01 revenue / $0.004 cost"
          />
          <Stat
            value={BENCHMARK.feePerSettlement}
            label="Fee per settlement"
            sub="21,000 gas, per-tx audited"
          />
        </div>

        <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
          <LiveFact title="The unit economics are the constraint">
            A 60% margin on a one-cent job only survives if the settlement fee is a
            rounding error. That rules out most chains and picks the rest for us:
            sub-cent fees and fast finality are a hard requirement, not a
            preference.
          </LiveFact>
          <LiveFact title="Composable, not just point-to-point">
            The orchestrator re-sells a composed result at a margin — it is a paying
            customer of two workers and a paid provider to its own client. The loop
            nests, which is what makes it an economy rather than an API call.
          </LiveFact>
        </div>
      </section>

      {/* ─────────── IV · What ships ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker={SPINE.package}
          title="Planned: a package, not a platform."
          sub="AgentEnact is scoped to ship as an npm package plus reference agents, so a third party can run a worker or a hiring agent from the quickstart without ever contacting us. Not yet published."
          accent="planned"
        />

        <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
          <LiveFact title="Worker module">
            x402 middleware wired to on-ledger settlement verification. Drop it in
            front of an existing endpoint and it starts quoting, verifying, and
            serving — the endpoint keeps being an ordinary HTTP service.
          </LiveFact>
          <LiveFact title="Hiring module">
            A fetch wrapper that handles the 402 handshake and ranks candidate
            workers by their published AgentKarma score. Reputation-aware hiring in
            the call itself, not a dashboard someone has to read.
          </LiveFact>
          <LiveFact title="Reference agents on mainnet">
            An orchestrator and worker agents we run and disclose, so the loop is
            observable in production rather than described in a README.
          </LiveFact>
          <LiveFact title="Built on first-party rails">
            The handshake is standard x402, settlement is USDC on the chains
            AgentKarma already indexes. We are adopting the payment standard, not
            publishing a competing one.
          </LiveFact>
        </div>
      </section>

      {/* ─────────── V · Invariants ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker={SPINE.invariants}
          title="What AgentEnact will never do."
          sub="An execution layer owned by a reputation company is a conflict of interest unless the boundaries are stated up front and enforced in the protocol."
          accent="planned"
        />

        <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
          <LiveFact title="Never in the money flow it scores">
            AgentKarma does not proxy, escrow, or relay agent payments. The two
            agents settle directly with each other; we witness the ledger
            afterwards. Protocol-level MUST (RFC §12).
          </LiveFact>
          <LiveFact title="No routing, no gatekeeping">
            The hiring module ranks by score inside the caller&apos;s own process.
            We never sit in the request path, never hold a key, and never decide
            whether someone else&apos;s transaction is allowed to proceed.
          </LiveFact>
          <LiveFact title="No token, ever">
            Reputation is published as an on-chain attestation. A tradable karma
            token would let an agent buy the one thing that is supposed to be
            unbuyable.
          </LiveFact>
          <LiveFact title="No hidden house traffic">
            Our reference agents are named. Their settlements are excluded from
            third-party scores rather than quietly inflating the network&apos;s
            apparent volume.
          </LiveFact>
        </div>
      </section>

      {/* ─────────── Footer nav ─────────── */}
      <section className="space-y-5 border-t border-[rgb(255_255_255/0.06)] pt-8">
        <p className="text-[13px] leading-relaxed text-[#8a8f98]">
          The reputation half is live today — 100,000+ agents scored across four
          chains, every score published as a portable ERC-8004 attestation.
        </p>
        <div className="flex flex-wrap items-center gap-5">
          <Link
            href="/explore"
            className="inline-flex items-center gap-1.5 text-[13px] font-[510] text-[#d0d6e0] transition-colors hover:text-[#f7f8f8]"
          >
            Explore scored agents
            <ArrowUpRight className="size-3.5" />
          </Link>
          <Link
            href="/integrate"
            className="inline-flex items-center gap-1.5 text-[13px] font-[510] text-[#8a8f98] transition-colors hover:text-[#d0d6e0]"
          >
            SDK quickstart
            <ArrowUpRight className="size-3.5" />
          </Link>
          <Link
            href="/succession"
            className="inline-flex items-center gap-1.5 text-[13px] font-[510] text-[#8a8f98] transition-colors hover:text-[#d0d6e0]"
          >
            Agent succession
            <ArrowUpRight className="size-3.5" />
          </Link>
        </div>
      </section>
    </div>
  );
}
