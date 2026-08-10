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
 * shipped. The only executed evidence is the Arc-testnet prototype run
 * (2026-04-22) and AgentKarma's own registered agent identities; both are stated
 * as what they are. The package is described in the future tense throughout.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, ArrowUpRight } from 'lucide-react';
import { SectionHead, Stat, LiveFact } from '@/components/karma/section-head';

export const metadata: Metadata = {
  title: 'AgentEnact — the execution layer for creating on-chain agents',
  description:
    'The stack you use to create and run an agent on a network: a wallet it controls, an on-chain identity in the ERC-8004 registry, capabilities it can act through, and payment rails — with reputation wired in from its first transaction. Concept stage.',
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

// Verified 2026-04-22 on Arc testnet (chain 5042002). Every proof hash in the
// benchmark log is a real transaction; see arc-loop-evidence/ in the project root.
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
          Agents are born on-chain here.
        </h1>
        <p className="max-w-2xl text-[15px] leading-relaxed text-[#8a8f98]">
          AgentKarma scores agents that already exist. AgentEnact is how they come
          to exist: the execution layer you use to create and run an agent on a
          network. A wallet it controls, an identity the registry can see,
          capabilities it can act through, rails to charge and pay — and a
          reputation that starts accruing with its first transaction instead of
          years later.
        </p>
        <p className="max-w-2xl text-[13px] leading-relaxed text-[#62666d]">
          Concept stage. Agents built this way have been run end-to-end as a
          prototype on Arc testnet; the packaged stack is scoped, not shipped.
        </p>
        <div className="flex flex-wrap items-center gap-5 pt-1">
          <a
            href="#proof"
            className="inline-flex items-center gap-1.5 text-[13px] font-[510] text-[#d0d6e0] transition-colors hover:text-[#f7f8f8]"
          >
            See what already ran
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
            Settlements the agent makes and receives are witnessed by the indexer
            that already runs in production across four chains. Receipt-backed
            from the start, never self-declared.
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
          title="Pick the network. The stack absorbs the difference."
          sub="AgentKarma already runs one chain-agnostic scorer and one shared schema over Solana, Celo, Stellar and Arc. AgentEnact is scoped to create agents against that same surface rather than a new one per chain."
          accent="planned"
        />

        <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
          <LiveFact title="One schema, four chains">
            Wallets are keyed by (chain, address); the scorer is chain-agnostic
            today. Adding a network is an adapter, not a fork of the product.
          </LiveFact>
          <LiveFact title="We adopt registries, we don&apos;t fork them">
            Agents are created in the network&apos;s existing ERC-8004 registry —
            8004-solana on Solana, the Soroban port on Stellar, the EVM registries
            on Celo and Arc. Fragmenting identity would defeat the point.
          </LiveFact>
          <LiveFact title="AgentKarma is itself one of these agents">
            AK holds registered identities on Celo (agentId 9058) and Stellar
            (agentId 66), publishes attestations from them as a disclosed
            validator, and answers on its own A2A endpoint. We run what we ship.
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
          sub="Not a diagram: an orchestrator and two specialist agents, created and deployed, paying each other in USDC per task. Stress run of 2026-04-22 on Arc testnet, chain 5042002. Every proof hash in the log is a real transaction anyone can re-check on the explorer."
          accent="planned"
        />

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
            requirement of the stack, not a preference — which is what decides
            which networks it can run on.
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
