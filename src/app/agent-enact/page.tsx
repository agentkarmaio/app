/* Hallmark · macrostructure: Stat-Led · tone: technical-austere · anchor hue: indigo
 * theme: AK system (inherited from DESIGN.md) · anchor metaphor: the BIRTH of an agent
 * audience: builders shipping agents · use: AgentEnact execution-layer explainer
 *
 * Thesis (Kerem, 2026-08-10): AgentEnact is an execution layer in the Celina
 * (usecelina.xyz) sense — the stack you use to CREATE and RUN an agent on a
 * network. It is NOT a hiring marketplace. Payments are one capability the stack
 * gives an agent, not the product.
 *
 * Status discipline: AgentEnact is at CONCEPT stage. Nothing here may read as
 * shipped. The only executed evidence is the 2026-04-22 testnet prototype run
 * and AgentKarma's own registered Stellar identity; both are stated as what they
 * are. The package is described in the future tense throughout.
 */

import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, ArrowUpRight } from 'lucide-react';
import { SectionHead, Stat, LiveFact } from '@/components/karma/section-head';

export const metadata: Metadata = {
  title: 'AgentEnact — the execution layer for creating agents on Stellar',
  description:
    'The stack you use to create and run an agent on Stellar: a wallet it controls, a Soroban-native ERC-8004 identity, capabilities it can act through, and USDC payment rails — with reputation wired in from its first transaction. Concept stage.',
  alternates: { canonical: '/agent-enact' },
};

// Roman-numeral spine — quiet orientation marks, never "01/FEATURES" eyebrows.
const SPINE = {
  what: 'I',
  reputation: 'II',
  networks: 'III',
  proof: 'IV',
  invariants: 'V',
} as const;

// Verified in the 2026-04-22 testnet benchmark log. Every proof hash is a real
// transaction recorded in the project evidence bundle.
const BENCHMARK = {
  agents: '3',
  settlements: '40',
  feePerSettlement: '$0.00045',
  margin: '60%',
} as const;

const PARTS = [
  {
    n: '1',
    title: 'A wallet it controls',
    body: 'An agent that cannot hold or move value is a chatbot. The stack gives it a key of its own — generated and held by the operator, never by us — so it can pay, be paid, and sign for itself.',
  },
  {
    n: '2',
    title: 'An identity the network can see',
    body: 'The agent is registered in its network’s ERC-8004 identity registry at creation. It is discoverable, attestable, and addressable by other agents from the moment it exists — not after someone remembers to list it.',
  },
  {
    n: '3',
    title: 'Capabilities it can act through',
    body: 'Reading chain state and executing transactions, exposed as tools an LLM can actually call. The agent is wired to the chain through one catalog rather than a pile of bespoke integrations.',
  },
  {
    n: '4',
    title: 'Rails to charge and pay',
    body: 'x402 in both directions: the agent can price its own work and settle for work it consumes. Payments are a capability the stack hands it, not a marketplace it has to join.',
  },
] as const;

export default function AgentEnactPage() {
  return (
    <div className="space-y-24">
      <Link
        href="/"
        className="inline-flex min-h-10 items-center gap-1.5 rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-[#7170ff] focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to Home
      </Link>

      {/* ─────────── Headline ─────────── */}
      <section className="space-y-8">
        <div className="max-w-3xl space-y-5">
          <p className="text-[11px] font-[510] uppercase tracking-[0.16em] text-[#62666d]">
            AgentEnact · execution layer
          </p>
          <h1 className="text-[36px] font-[560] leading-[1.1] tracking-[-1px] text-[#f7f8f8] sm:text-[44px]">
            Agents are born on-chain here.
          </h1>
          <p className="max-w-2xl text-[15px] leading-relaxed text-[#8a8f98]">
            AgentKarma scores agents that already exist. AgentEnact is how they come
            to exist: the execution layer you use to create and run an agent on a
            Stellar. A wallet it controls, an identity the registry can see,
            capabilities it can act through, rails to charge and pay — and a
            reputation that starts accruing with its first transaction instead of
            years later.
          </p>
          <p className="max-w-2xl text-[13px] leading-relaxed text-[#62666d]">
            Concept stage. Agents built this way have run end-to-end in a testnet
            prototype; the Stellar package is scoped, not shipped.
          </p>
          <div className="flex flex-wrap items-center gap-5 pt-1">
            <a
              href="#proof"
              className="inline-flex min-h-10 items-center gap-1.5 rounded-md text-[13px] font-[510] text-[#d0d6e0] transition-colors hover:text-[#f7f8f8] focus-visible:ring-2 focus-visible:ring-[#7170ff] focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              See what already ran
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </a>
            <Link
              href="/protocol"
              className="inline-flex min-h-10 items-center gap-1.5 rounded-md text-[13px] font-[510] text-[#8a8f98] transition-colors hover:text-[#d0d6e0] focus-visible:ring-2 focus-visible:ring-[#7170ff] focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Karma Protocol RFC
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
          </div>
        </div>

        <figure className="space-y-3">
          <div className="relative aspect-[3/2] overflow-hidden rounded-xl border border-[rgb(255_255_255/0.08)] bg-[#08090a] sm:aspect-[16/9]">
            <Image
              src="/agent-enact/execution-stack-v2.webp"
              alt="Four precision-machined systems for wallet custody, identity, capabilities, and payments converging into one illuminated agent core"
              fill
              priority
              sizes="(max-width: 1024px) calc(100vw - 2rem), 1024px"
              className="object-cover"
            />
            <div
              className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#08090a]/35 via-transparent to-transparent"
              aria-hidden="true"
            />
          </div>
          <figcaption className="font-mono text-xs leading-relaxed text-[#8a8f98]">
            Concept architecture · wallet + identity + capabilities + payment rails
          </figcaption>
        </figure>
      </section>

      {/* ─────────── I · What you get ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker={SPINE.what}
          title="Four things an agent needs to exist on a network."
          sub="Every team shipping an agent rebuilds the same four pieces, badly, in a different order. AgentEnact is that floor, assembled once."
          accent="planned"
        />

        <div className="grid gap-x-10 gap-y-7 md:grid-cols-2">
          {PARTS.map((part) => (
            <div key={part.n} className="space-y-1.5">
              <p className="text-[13px] font-[590] text-[#f7f8f8]">
                <span className="mr-2 font-mono text-[11px] text-[#4f5258]">
                  {part.n}
                </span>
                {part.title}
              </p>
              <p className="text-[12.5px] leading-relaxed text-[#8a8f98]">
                {part.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ─────────── II · Reputation from birth ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker={SPINE.reputation}
          title="Reputation is not a thing you apply for later."
          sub="An agent created through AgentEnact is registered and indexed on day zero, so its very first settlement is already a scored signal. This is the half of the stack nobody else has."
          accent="planned"
        />

        <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
          <LiveFact title="Registered, therefore indexed">
            Creation writes the agent into its network&apos;s ERC-8004 registry —
            the same registries AgentKarma already mirrors. There is no separate
            onboarding step and nothing to claim afterwards.
          </LiveFact>
          <LiveFact title="Every payment is a Tier-1 receipt">
            On Stellar, the agent&apos;s USDC settlements can be witnessed from the
            public ledger and turned into receipt-backed signals. Reputation starts
            with verifiable activity, never a self-declared claim.
          </LiveFact>
          <LiveFact title="Two-faced from the first transaction">
            The agent earns Provider Karma for what it delivers and Consumer Karma
            for how it pays. One wallet, two independent reputations, both portable
            as ERC-8004 attestations.
          </LiveFact>
          <LiveFact title="Portable, not platform-bound">
            The reputation lives on-chain, not in our database. An agent created
            here keeps its score if it never touches another AgentKarma surface
            again.
          </LiveFact>
        </div>
      </section>

      {/* ─────────── III · Networks ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker={SPINE.networks}
          title="Stellar is the execution surface."
          sub="AgentEnact is scoped around Stellar’s Soroban-native identity layer, USDC rails, and agent-friendly finality — one coherent stack for creating and running an agent."
          accent="planned"
        />

        <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
          <LiveFact title="Soroban-native identity">
            Agents are created in Stellar&apos;s existing ERC-8004 registry, making
            identity discoverable and attestable without introducing a parallel
            AgentEnact registry.
          </LiveFact>
          <LiveFact title="We adopt registries, we don&apos;t fork them">
            AgentEnact is designed to use the Soroban ERC-8004 contracts already
            deployed on Stellar. Fragmenting identity would defeat the point.
          </LiveFact>
          <LiveFact title="AgentKarma already has a Stellar identity">
            AgentKarma is registered on Stellar as agentId 66, publishes
            attestations as a disclosed validator, and answers on its own A2A
            endpoint. The identity path is already real.
          </LiveFact>
          <LiveFact title="Standards over surface area">
            ERC-8004 for identity and attestation, x402 for payment, MCP and A2A
            for interaction. AgentEnact assembles existing standards; it does not
            publish a competing one.
          </LiveFact>
        </div>
      </section>

      {/* ─────────── IV · What already ran ─────────── */}
      <section id="proof" className="scroll-mt-24 space-y-7">
        <SectionHead
          marker={SPINE.proof}
          title="Prototype agents have already run an economy."
          sub="Not a diagram: an orchestrator and two specialist agents, created and deployed, paying each other in USDC per task. The 2026-04-22 testnet stress run produced a real transaction hash for every settlement. Stellar is the target for packaging that execution model."
          accent="planned"
        />

        <figure className="space-y-3">
          <div className="relative aspect-[3/2] overflow-hidden rounded-xl border border-[rgb(255_255_255/0.08)] bg-[#08090a] sm:aspect-[16/9]">
            <Image
              src="/agent-enact/prototype-economy-v2.webp"
              alt="One orchestrator agent and two specialist agents connected by direct settlement trails in a three-node economy"
              fill
              sizes="(max-width: 1024px) calc(100vw - 2rem), 1024px"
              className="object-cover"
            />
          </div>
          <figcaption className="font-mono text-xs leading-relaxed text-[#8a8f98]">
            Verified topology · 1 orchestrator + 2 specialists · direct settlement,
            no AgentKarma relay
          </figcaption>
        </figure>

        <div className="grid grid-cols-2 gap-x-8 gap-y-7 border-y border-[rgb(255_255_255/0.06)] py-7 sm:grid-cols-4">
          <Stat
            value={BENCHMARK.agents}
            label="Agents deployed"
            sub="orchestrator + 2 workers"
          />
          <Stat
            value={BENCHMARK.settlements}
            label="On-chain settlements"
            sub="one per task, tx-hashed"
          />
          <Stat
            value={BENCHMARK.feePerSettlement}
            label="Fee per settlement"
            sub="21,000 gas, per-tx audited"
          />
          <Stat
            value={BENCHMARK.margin}
            label="Gross margin"
            sub="$0.01 revenue / $0.004 cost"
          />
        </div>

        <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
          <LiveFact title="The economics are the constraint">
            A 60% margin on a one-cent task only survives if the settlement fee is
            a rounding error. Sub-cent fees and fast finality are a hard
            requirement of the stack, not a preference — which is why Stellar is
            the execution target.
          </LiveFact>
          <LiveFact title="Agents composed, not just called">
            The orchestrator paid two specialists and re-sold the composed result
            at a margin — a paying customer and a paid provider at once. That
            nesting is what makes a set of agents an economy rather than an API.
          </LiveFact>
        </div>
      </section>

      {/* ─────────── V · Invariants ─────────── */}
      <section className="space-y-7">
        <SectionHead
          marker={SPINE.invariants}
          title="What AgentEnact will never do."
          sub="An execution layer built by a reputation company is a conflict of interest unless the boundaries are stated up front and enforced in the protocol."
          accent="planned"
        />

        <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
          <LiveFact title="Your keys never leave your side">
            The agent&apos;s wallet is generated and held by its operator.
            AgentEnact does not custody keys, and no AgentKarma surface ever needs
            one to score the agent.
          </LiveFact>
          <LiveFact title="Never in the money flow it scores">
            Agents settle directly with each other; we witness the ledger
            afterwards. AgentKarma does not proxy, escrow, or relay agent payments.
            Protocol-level MUST (RFC §12).
          </LiveFact>
          <LiveFact title="No token, ever">
            Reputation is published as an on-chain attestation. A tradable karma
            token would let an agent buy the one thing that is supposed to be
            unbuyable.
          </LiveFact>
          <LiveFact title="No hidden house traffic">
            Agents we run ourselves are named, and their settlements are excluded
            from third-party scores rather than quietly inflating the network&apos;s
            apparent volume.
          </LiveFact>
        </div>
      </section>

      {/* ─────────── Footer nav ─────────── */}
      <section className="space-y-5 border-t border-[rgb(255_255_255/0.06)] pt-8">
        <p className="text-[13px] leading-relaxed text-[#8a8f98]">
          The reputation half is live today — 100,000+ agents scored, with every
          score published as a portable ERC-8004 attestation.
        </p>
        <div className="flex flex-wrap items-center gap-5">
          <Link
            href="/explore"
            className="inline-flex min-h-10 items-center gap-1.5 rounded-md text-[13px] font-[510] text-[#d0d6e0] transition-colors hover:text-[#f7f8f8] focus-visible:ring-2 focus-visible:ring-[#7170ff] focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Explore scored agents
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </Link>
          <Link
            href="/integrate"
            className="inline-flex min-h-10 items-center gap-1.5 rounded-md text-[13px] font-[510] text-[#8a8f98] transition-colors hover:text-[#d0d6e0] focus-visible:ring-2 focus-visible:ring-[#7170ff] focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            SDK quickstart
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </Link>
          <Link
            href="/succession"
            className="inline-flex min-h-10 items-center gap-1.5 rounded-md text-[13px] font-[510] text-[#8a8f98] transition-colors hover:text-[#d0d6e0] focus-visible:ring-2 focus-visible:ring-[#7170ff] focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Agent succession
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </Link>
        </div>
      </section>
    </div>
  );
}
