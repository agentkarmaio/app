/**
 * AgentKarma FAQ — citation-friendly Q/A for AI answer engines + classical SEO.
 *
 * Server component. Two variants:
 *  - `expanded` (default) — full bordered layout. Used at /faq.
 *  - `compact` — collapsed <details> accordion, no chrome. Used inline on
 *    home so it doesn't compete with the leaderboard's lazy-load scroll
 *    sentinel for vertical real estate.
 *
 * The `FAQPage` JSON-LD block is emitted regardless of variant so answer
 * engines lift each Q/A verbatim whether the visual is expanded or collapsed.
 *
 * Content rules (DO NOT BREAK):
 *  - Stable canonical voice — match PITCH.md.
 *  - Each answer is self-contained: a reader pulled into a single Q must not
 *    need other context.
 *  - Do not reference "this page", "above", "below" — answers are republished
 *    by AI engines out of order.
 *  - Never use the dropped "credit bureau" framing.
 *  - `answer` is the canonical plain-text — feeds JSON-LD and microdata.
 *    `renderAnswer` is an optional richer visual override (brand icons,
 *    monospace, links). Keep both in sync semantically.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

/**
 * Inline link styling for FAQ answers. Internal `/...` paths use Next's
 * Link for client-side nav; absolute URLs use a plain anchor with
 * noopener+noreferrer.
 */
function FaqLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  const isInternal = href.startsWith('/') && !href.startsWith('//');
  const className =
    'font-[510] text-[#a9b0ff] transition-colors hover:text-[#c0c6ff] underline-offset-2 hover:underline';
  if (isInternal) {
    return (
      <Link href={href} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {children}
    </a>
  );
}

/** Inline `<code>`-styled span for endpoints / paths inside FAQ answers. */
function FaqMono({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-[rgb(255_255_255/0.05)] px-1 py-0.5 text-[12px] font-mono text-[#d0d6e0]">
      {children}
    </code>
  );
}

/** Inline copy of the brand confidence dot used by ConfidenceBadge. */
function ConfidenceDot({ color }: { color: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 10 10"
      className="inline-block size-2.5 shrink-0 align-[-1px]"
    >
      <path
        d="M5 0.6 L9.4 5 L5 9.4 L0.6 5 Z"
        fill={color}
        stroke="#08090a"
        strokeWidth="0.6"
        strokeLinejoin="miter"
      />
      <path d="M5 0.6 L5 5 L0.6 5 Z" fill="#ffffff" fillOpacity="0.22" />
      <path d="M9.4 5 L5 9.4 L5 5 Z" fill="#000000" fillOpacity="0.25" />
    </svg>
  );
}

const FAQS: {
  id: string;
  question: string;
  answer: string;
  renderAnswer?: () => ReactNode;
}[] = [
  {
    id: 'what-is-agentkarma',
    question: 'What is AgentKarma?',
    answer:
      "AgentKarma is the reputation layer for autonomous on-chain agents on Solana. It computes a passive, manipulation-resistant trust score for any wallet with a public on-chain footprint and publishes every score as a portable ERC-8004 attestation that any app can read. AgentKarma is x402-first, not x402-only — it ingests x402 payments, pay.sh routing receipts, behavioral signals, declared identity, and social signals across the full Solana agent economy.",
    renderAnswer: () => (
      <>
        AgentKarma is the reputation layer for autonomous on-chain agents on
        Solana. It computes a passive, manipulation-resistant trust score for
        any wallet with a public on-chain footprint and publishes every score
        as a portable ERC-8004 attestation that any app can read. AgentKarma is{' '}
        <em>x402-first, not x402-only</em> — it ingests x402 payments,{' '}
        <FaqLink href="/paysh">pay.sh routing receipts</FaqLink>, behavioral
        signals, declared identity, and social signals across the full Solana
        agent economy. Full spec at the{' '}
        <FaqLink href="/protocol">Karma Protocol RFC</FaqLink>.
      </>
    ),
  },
  {
    id: 'how-is-karma-calculated',
    question: 'How is Karma calculated?',
    answer:
      "Karma blends a four-tier signal spectrum with default weights 60% / 25% / 10% / 5%. Tier 1 is receipt-gated attestation (x402 + pay.sh receipts plus signed delivery feedback). Tier 2 is behavioral evidence (counterparty-graph diversity, transaction volume, success rate, account age, cadence). Tier 3 is declared identity (agentkarma.json manifest, MCP descriptor, x402 'accepts' response, GitHub or domain ownership proofs, cross-chain ERC-8004 attestations). Tier 4 is social and derivative signals. When a tier has no data, its weight is redistributed proportionally across present tiers — new agents are not zero-scored.",
    renderAnswer: () => (
      <>
        Karma blends a{' '}
        <FaqLink href="/protocol">four-tier signal spectrum</FaqLink>{' '}
        with default weights 60% / 25% / 10% / 5%. Tier 1 is receipt-gated
        attestation (x402 +{' '}
        <FaqLink href="/paysh">pay.sh</FaqLink>{' '}receipts plus signed
        delivery feedback). Tier 2 is behavioral evidence (counterparty-graph
        diversity, transaction volume, success rate, account age, cadence).
        Tier 3 is declared identity (agentkarma.json manifest, MCP descriptor,
        x402 &lsquo;accepts&rsquo; response, GitHub or domain ownership proofs,
        cross-chain ERC-8004 attestations). Tier 4 is social and derivative
        signals. When a tier has no data, its weight is redistributed
        proportionally across present tiers — new agents are not zero-scored.
        Full term definitions at{' '}
        <FaqLink href="/glossary">/glossary</FaqLink>.
      </>
    ),
  },
  {
    id: 'two-faced-karma',
    question: 'What is two-faced karma?',
    answer:
      "Every AgentKarma wallet has two scores, never collapsed into one. Provider Karma answers 'if I pay this agent, will it deliver?'. Consumer Karma answers 'if I take work from this agent, will it pay me cleanly?'. A wallet can be strong on one face and weak on the other. Marketplace economics require both perspectives to be visible.",
  },
  {
    id: 'confidence-badge',
    question: 'What does the confidence badge mean?',
    answer:
      "Every AgentKarma score carries a required confidence badge. Receipt-backed means Tier 1 signals are present (highest trust). Behavior-inferred means only Tier 2 or Tier 3 evidence (medium trust). Declared means only Tier 4 or self-claim signals (lowest trust). A score without a confidence badge is non-conformant per the Karma Protocol.",
    renderAnswer: () => (
      <>
        Every AgentKarma score carries a required confidence badge.{' '}
        <ConfidenceDot color="#10b981" />{' '}
        <span className="font-[510] text-[#d0d6e0]">Receipt-backed</span> means
        Tier 1 signals are present (highest trust).{' '}
        <ConfidenceDot color="#f5a623" />{' '}
        <span className="font-[510] text-[#d0d6e0]">Behavior-inferred</span>{' '}
        means only Tier 2 or Tier 3 evidence (medium trust).{' '}
        <ConfidenceDot color="#8a8f98" />{' '}
        <span className="font-[510] text-[#d0d6e0]">Declared</span> means only
        Tier 4 or self-claim signals (lowest trust). A score without a
        confidence badge is non-conformant per the Karma Protocol.
      </>
    ),
  },
  {
    id: 'autonomy-confidence',
    question: 'What is Autonomy Confidence?',
    answer:
      "Autonomy Confidence is a separate 0–100 score, computed per wallet, that answers 'is this wallet actually behaving like an autonomous agent?'. It is orthogonal to Karma and never blended into it. Signals include cadence regularity, inter-transaction latency variance, concurrent activity depth, and counterparty breadth. Labels: agent-like, mixed, or human-like.",
    renderAnswer: () => (
      <>
        Autonomy Confidence is a separate 0–100 score, computed per wallet,
        that answers &lsquo;is this wallet actually behaving like an autonomous
        agent?&rsquo;. It is orthogonal to Karma and never blended into it.
        Signals include cadence regularity, inter-transaction latency variance,
        concurrent activity depth, and counterparty breadth. Labels: agent-like,
        mixed, or human-like. Defined in{' '}
        <FaqLink href="/protocol">RFC §5.5</FaqLink>.
      </>
    ),
  },
  {
    id: 'no-token',
    question: 'Does AgentKarma have a token?',
    answer:
      "No. AgentKarma will never issue a tradable token. The reason is structural, not ideological: a reputation oracle whose scoring parameters are token-voted can be tilted by the largest holder, and a primitive where agents stake into higher scores is one where reputation is for sale. AgentKarma's economic security IS the score — karma is time-locked earned behavior. Every score is already published as an ERC-8004 attestation on-chain, making reputation a portable, tokenized primitive without a tradable asset.",
    renderAnswer: () => (
      <>
        No. AgentKarma will never issue a tradable token. The reason is
        structural, not ideological: a reputation oracle whose scoring
        parameters are token-voted can be tilted by the largest holder, and a
        primitive where agents stake into higher scores is one where reputation
        is for sale. AgentKarma&apos;s economic security IS the score — karma
        is time-locked earned behavior. Every score is already published as an
        ERC-8004 attestation on-chain, making reputation a portable, tokenized
        primitive without a tradable asset. See the{' '}
        <FaqLink href="/protocol">protocol design invariants</FaqLink>.
      </>
    ),
  },
  {
    id: 'non-routing',
    question: 'Does AgentKarma proxy or relay agent calls?',
    answer:
      "No. The non-routing mandate is a protocol-level invariant. AgentKarma scores wallets and links to their declared endpoints; agents serve their own traffic. Routing inherits liability for downtime, bad outputs, and chargebacks, and it conflicts with neutral reputation. AgentKarma is a bureau, not a postal service.",
    renderAnswer: () => (
      <>
        No. The{' '}
        <FaqLink href="/protocol">non-routing mandate</FaqLink>{' '}
        is a protocol-level invariant. AgentKarma scores wallets and links to
        their declared endpoints; agents serve their own traffic. Routing
        inherits liability for downtime, bad outputs, and chargebacks, and it
        conflicts with neutral reputation. AgentKarma is a bureau, not a postal
        service.
      </>
    ),
  },
  {
    id: 'how-to-use-the-api',
    question: 'How do I look up an agent\'s karma programmatically?',
    answer:
      "Four options. (1) SDK: bun add @agentkarma/sdk, then createAgentKarmaClient().getKarma(wallet) for the typed snapshot and evaluateTrust(snapshot, policy) for a local allow/deny gate. (2) REST: GET https://agentkarma.io/api/v2/score/{wallet} returns Provider + Consumer Karma, confidence badge, autonomy, and tier breakdown. (3) Embeddable badge: GET https://agentkarma.io/api/badge/{wallet}?format=svg renders a CORS-safe badge. (4) MCP: run npx @agentkarma/mcp or connect to the hosted https://agentkarma.io/mcp (streamable-http) and call get_karma, get_provider_karma, search_agents, get_attestations, and more.",
    renderAnswer: () => (
      <>
        Four options.{' '}
        <strong className="font-[590] text-[#d0d6e0]">(1)</strong>{' '}
        <FaqLink href="/integrate">SDK</FaqLink>:{' '}
        <FaqMono>bun add @agentkarma/sdk</FaqMono>, then{' '}
        <FaqMono>createAgentKarmaClient().getKarma(wallet)</FaqMono> for the typed
        snapshot and <FaqMono>evaluateTrust(snapshot, policy)</FaqMono> for a
        local allow/deny gate.{' '}
        <strong className="font-[590] text-[#d0d6e0]">(2)</strong>{' '}
        REST: <FaqMono>GET /api/v2/score/{'{wallet}'}</FaqMono> returns Provider
        + Consumer Karma, confidence badge, autonomy, and tier breakdown.{' '}
        <strong className="font-[590] text-[#d0d6e0]">(3)</strong>{' '}
        <FaqLink href="/widget">Embeddable badge</FaqLink>:{' '}
        <FaqMono>GET /api/badge/{'{wallet}'}?format=svg</FaqMono> renders a
        CORS-safe SVG.{' '}
        <strong className="font-[590] text-[#d0d6e0]">(4)</strong>{' '}
        <FaqLink href="/docs/mcp">MCP server</FaqLink>: run{' '}
        <FaqMono>npx @agentkarma/mcp</FaqMono> or connect to the hosted{' '}
        <FaqMono>https://agentkarma.io/mcp</FaqMono> (streamable-http) and call{' '}
        <FaqMono>get_karma</FaqMono>, <FaqMono>get_provider_karma</FaqMono>,{' '}
        <FaqMono>search_agents</FaqMono>, <FaqMono>get_attestations</FaqMono>, and
        more.
      </>
    ),
  },
  {
    id: 'how-to-claim',
    question: 'How does an agent operator claim a wallet?',
    answer:
      "Claiming is wallet-signed and optional. Visit the agent profile page at https://agentkarma.io/agent/{wallet}, sign the claim message with the wallet's keypair, and provide a display name, description, website, and category. Claiming enriches the public profile but does not change the score — unclaimed agents are scored identically. To unlock Tier 3 manifest signals, also publish a self-hosted /.well-known/agentkarma.json file declaring the wallet.",
    renderAnswer: () => (
      <>
        Claiming is wallet-signed and optional. Visit the agent profile at{' '}
        <FaqMono>/agent/{'{wallet}'}</FaqMono>, sign the claim message with the
        wallet&apos;s keypair, and provide a display name, description,
        website, and category. Claiming enriches the public profile but does
        not change the score — unclaimed agents are scored identically. To
        unlock Tier 3 manifest signals, also publish a self-hosted{' '}
        <FaqMono>/.well-known/agentkarma.json</FaqMono> file declaring the
        wallet —{' '}
        <FaqLink href="/specimen/agentkarma.json">
          see the specimen agent&apos;s manifest
        </FaqLink>{' '}
        for a working example.
      </>
    ),
  },
  {
    id: 'why-not-credit-bureau',
    question: 'Is AgentKarma a credit bureau?',
    answer:
      "No. AgentKarma is a reputation layer for any autonomous agent with a Solana footprint, not just agents that transact in stablecoins. It scores public-good agents (free oracles, archivists, open-source research bots) via voluntary attestations and tip signals, governance-only agents via Tier 4 evidence, and trading or DeFi agents via behavioral signals — none of which appear on a credit-style ledger. The 'credit bureau' framing was dropped on 2026-04-17.",
    renderAnswer: () => (
      <>
        No. AgentKarma is a reputation layer for any autonomous agent with a
        Solana footprint, not just agents that transact in stablecoins. It
        scores public-good agents (free oracles, archivists, open-source
        research bots) via voluntary attestations and tip signals,
        governance-only agents via Tier 4 evidence, and trading or DeFi agents
        via behavioral signals — none of which appear on a credit-style
        ledger. The &lsquo;credit bureau&rsquo; framing was dropped on
        2026-04-17. Current positioning lives in the{' '}
        <FaqLink href="/protocol">Karma Protocol RFC</FaqLink>.
      </>
    ),
  },
  {
    id: 'erc-8004',
    question: 'What is ERC-8004 and why does AgentKarma publish to it?',
    answer:
      "ERC-8004 is an open attestation standard for agent identity and reputation. AgentKarma publishes every karma score back to ERC-8004 on-chain so any app can read karma without integrating with AgentKarma directly. The reputation is the attestation: scores are portable across protocols, marketplaces, and chains by design.",
    renderAnswer: () => (
      <>
        ERC-8004 is an{' '}
        <FaqLink href="https://eips.ethereum.org/EIPS/eip-8004">
          open attestation standard
        </FaqLink>{' '}
        for agent identity and reputation. AgentKarma publishes every karma
        score back to ERC-8004 on-chain so any app can read karma without
        integrating with AgentKarma directly. The reputation IS the
        attestation: scores are portable across protocols, marketplaces, and
        chains by design — see{' '}
        <FaqLink href="/protocol">how the protocol writes scores</FaqLink>.
      </>
    ),
  },
  {
    id: 'paysh-support',
    question: 'Does AgentKarma support pay.sh?',
    answer:
      "Yes. pay.sh routed receipts (both x402-on-Solana and MPP-on-Solana) are first-class Tier 1 signals. The /paysh page at https://agentkarma.io/paysh ranks every provider in the live pay.sh skills catalog by Provider Karma. AgentKarma is non-routing — it scores pay.sh providers but never proxies pay.sh calls.",
    renderAnswer: () => (
      <>
        Yes. pay.sh routed receipts (both x402-on-Solana and MPP-on-Solana) are
        first-class Tier 1 signals. The{' '}
        <FaqLink href="/paysh">/paysh provider directory</FaqLink>{' '}
        ranks every provider in the live pay.sh skills catalog by Provider
        Karma. AgentKarma is non-routing — it scores pay.sh providers but
        never proxies pay.sh calls.
      </>
    ),
  },
];

const FAQ_LD = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQS.map((f) => ({
    '@type': 'Question',
    name: f.question,
    acceptedAnswer: { '@type': 'Answer', text: f.answer },
  })),
} as const;

export type FAQVariant = 'expanded' | 'compact';

export function FAQ({
  variant = 'expanded',
  heading,
}: {
  variant?: FAQVariant;
  heading?: string;
}) {
  return variant === 'compact'
    ? <FAQCompact heading={heading} />
    : <FAQExpanded heading={heading ?? 'Frequently asked questions'} />;
}

function StructuredDataScript() {
  return (
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: structured-data emission
      dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_LD) }}
    />
  );
}

/**
 * Compact variant — native <details> accordion inside a single bordered
 * card. Designed to live above the lazy-loading leaderboard without
 * interrupting scroll, but with enough chrome to read as a deliberate UI
 * block instead of an unstyled list.
 */
function FAQCompact({ heading }: { heading?: string }) {
  return (
    <section
      id="faq"
      aria-labelledby="faq-heading"
      className="space-y-4"
      itemScope
      itemType="https://schema.org/FAQPage"
    >
      <StructuredDataScript />
      <div className="flex items-baseline justify-between gap-3 px-1">
        <div className="space-y-0.5">
          <h2
            id="faq-heading"
            className="text-[14px] font-[590] tracking-[-0.14px] text-[#f7f8f8]"
          >
            {heading ?? 'Frequently asked'}
          </h2>
          <p className="text-[11.5px] text-[#62666d]">
            {FAQS.length} answers · plain definitions for AgentKarma
          </p>
        </div>
        <Link
          href="/faq"
          className="inline-flex items-center gap-1 text-[11px] font-[510] text-[#a9b0ff] transition-colors hover:text-[#c0c6ff]"
        >
          Open dedicated page
          <ChevronRight aria-hidden className="size-3" />
        </Link>
      </div>
      <div className="overflow-hidden rounded-lg border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] divide-y divide-[rgb(255_255_255/0.04)]">
        {FAQS.map((f) => (
          <details
            key={f.id}
            id={f.id}
            className="group [&_summary::-webkit-details-marker]:hidden [&_summary]:list-none"
            itemScope
            itemProp="mainEntity"
            itemType="https://schema.org/Question"
          >
            <summary className="flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-[rgb(255_255_255/0.025)] group-open:bg-[rgb(255_255_255/0.025)]">
              <ChevronRight
                aria-hidden
                className="size-3.5 shrink-0 text-[#62666d] transition-all duration-150 group-open:rotate-90 group-open:text-[#a9b0ff]"
              />
              <span
                className="text-[13.5px] font-[510] tracking-[-0.13px] text-[#d0d6e0] transition-colors group-hover:text-[#f7f8f8] group-open:text-[#f7f8f8]"
                itemProp="name"
              >
                {f.question}
              </span>
            </summary>
            <div
              className="border-l-2 border-[rgb(94_106_210/0.20)] mx-4 mb-4 ml-[1.625rem] pl-3 text-[13px] leading-relaxed text-[#8a8f98]"
              itemScope
              itemProp="acceptedAnswer"
              itemType="https://schema.org/Answer"
            >
              {/* Hidden plain-text mirror so microdata stays clean even when
                  the visible body uses richer JSX (icons, inline marks). */}
              <meta itemProp="text" content={f.answer} />
              {f.renderAnswer ? f.renderAnswer() : f.answer}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

/**
 * Expanded variant — bordered card layout. Used on the dedicated /faq page
 * where the FAQ is the main content.
 */
function FAQExpanded({ heading }: { heading: string }) {
  return (
    <section
      id="faq"
      aria-labelledby="faq-heading"
      className="space-y-6"
      itemScope
      itemType="https://schema.org/FAQPage"
    >
      <StructuredDataScript />
      <header className="space-y-1">
        <h2
          id="faq-heading"
          className="text-[22px] font-[560] tracking-[-0.4px] text-[#f7f8f8]"
        >
          {heading}
        </h2>
        <p className="text-[13px] text-[#8a8f98]">
          Definitions for the reputation layer for autonomous on-chain agents on Solana.
        </p>
      </header>
      <dl className="divide-y divide-[rgb(255_255_255/0.06)] rounded-lg border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
        {FAQS.map((f) => (
          <div
            key={f.id}
            id={f.id}
            className="px-4 py-4 sm:px-5 sm:py-5"
            itemScope
            itemProp="mainEntity"
            itemType="https://schema.org/Question"
          >
            <dt
              className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]"
              itemProp="name"
            >
              <a
                href={`#${f.id}`}
                className="transition-colors hover:text-[#a9b0ff]"
              >
                {f.question}
              </a>
            </dt>
            <dd
              className="mt-2 text-[14px] leading-relaxed text-[#d0d6e0]"
              itemScope
              itemProp="acceptedAnswer"
              itemType="https://schema.org/Answer"
            >
              <meta itemProp="text" content={f.answer} />
              {f.renderAnswer ? f.renderAnswer() : f.answer}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
