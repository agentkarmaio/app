/* SignalsBand — home marketing band introducing the two newest observe-only
 * signal layers (Agent Wills + Agent Bonding). Inserted between the leaderboard
 * and the FAQ: "and here is the newest signal layer".
 *
 * Asymmetric by design (anti-slop guard): NOT two symmetric icon-topped cards.
 * One band split by a centered custody seam — "AgentKarma witnesses · never
 * holds" — which is the composition's spine, not a footnote.
 *
 * Left  = Succession (ships first, live-partial): timeline + Estates preview.
 * Right = Bonding (gated): Lloyd's mini-row under a planned·contingent pill.
 */

import Link from 'next/link';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { SuccessionTimelineChart } from '@/components/karma/succession-timeline-chart';
import { StatusPill } from '@/components/karma/section-head';

export function SignalsBand() {
  return (
    <section
      aria-labelledby="signals-band-title"
      className="overflow-hidden rounded-xl border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.015)]"
    >
      {/* header */}
      <div className="space-y-2 px-6 pt-6 sm:px-8 sm:pt-8">
        <p className="text-[11px] font-[510] uppercase tracking-[0.16em] text-[#62666d]">
          Newest signal layer
        </p>
        <h2
          id="signals-band-title"
          className="max-w-2xl text-[22px] font-[590] leading-[1.2] tracking-[-0.4px] text-[#f7f8f8] sm:text-[26px]"
        >
          Two new signals, one custody rule. We witness both, we hold neither.
        </h2>
        <p className="max-w-2xl text-[13px] leading-relaxed text-[#8a8f98]">
          Custody and execution live in edge contracts on-chain. AgentKarma only
          indexes the lifecycle and turns it into reputation. Succession rides
          every score live across all chains today; bonding previews on demo data
          until founder sign-off.
        </p>
      </div>

      {/* asymmetric body: 1.25fr succession | seam | 1fr bonding */}
      <div className="mt-6 grid items-stretch md:grid-cols-[minmax(0,1.25fr)_auto_minmax(0,1fr)]">
        {/* LEFT — Succession */}
        <div className="space-y-4 px-6 pb-6 sm:px-8 sm:pb-8">
          <div className="flex items-center gap-2.5">
            <span className="text-[13px] font-[590] text-[#f7f8f8]">
              Agent Wills
            </span>
            <StatusPill accent="live-partial" />
          </div>
          <p className="text-[12.5px] leading-relaxed text-[#8a8f98]">
            An agent declares an heir and a heartbeat interval. AgentKarma derives
            the heartbeat from on-chain liveness and becomes the{' '}
            <span className="text-[#d0d6e0]">notary of agent succession</span>.
          </p>

          <SuccessionTimelineChart className="py-1" />

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-1">
            <Link
              href="/succession"
              className="inline-flex items-center gap-1.5 text-[12.5px] font-[510] text-[#d0d6e0] transition-colors hover:text-[#f7f8f8]"
            >
              How succession works
              <ArrowRight className="size-3" />
            </Link>
            <Link
              href="/estates"
              className="inline-flex items-center gap-1.5 text-[12.5px] font-[510] text-[#8a8f98] transition-colors hover:text-[#d0d6e0]"
            >
              Agent Estates
              <ArrowUpRight className="size-3" />
            </Link>
          </div>
        </div>

        {/* SEAM — the custody invariant, vertical on desktop */}
        <div className="relative flex items-center justify-center border-y border-[rgb(255_255_255/0.06)] py-3 md:border-x md:border-y-0 md:py-0">
          <span className="px-4 text-center font-mono text-[9.5px] uppercase tracking-[0.16em] text-[#4f5258] md:[writing-mode:vertical-rl] md:rotate-180">
            witnesses · never holds
          </span>
        </div>

        {/* RIGHT — Bonding (gated) */}
        <div className="space-y-4 px-6 pb-6 sm:px-8 sm:pb-8">
          <div className="flex items-center gap-2.5">
            <span className="text-[13px] font-[590] text-[#f7f8f8]">
              Agent Bonding
            </span>
            <StatusPill accent="contingent" />
          </div>
          <p className="text-[12.5px] leading-relaxed text-[#8a8f98]">
            A third party stakes USDC in an edge escrow vouching a young agent
            will deliver. We read the bond lifecycle as a Tier-1 vouched-capacity
            signal — previewing on demo data until founder sign-off.{' '}
            <span className="text-[#d0d6e0]">Lloyd&apos;s of London</span> for
            autonomous agents.
          </p>

          <div className="space-y-2 rounded-lg border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.015)] p-4">
            <div className="flex items-center justify-between text-[11px] text-[#62666d]">
              <span className="font-mono text-[#8a8f98]">surety_9a1f…</span>
              <span className="font-mono">2,500 USDC</span>
            </div>
            <div className="flex items-center justify-between text-[11px] text-[#62666d]">
              <span className="font-mono text-[#8a8f98]">surety_4c08…</span>
              <span className="font-mono">5,000 USDC</span>
            </div>
            <div className="border-t border-[rgb(255_255_255/0.06)] pt-2 text-[10.5px] text-[#4f5258]">
              Lloyd&apos;s leaderboard — sample, not live until sign-off.
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-[#62666d]">
            A bond lifts the confidence badge, never the trust-tier ceiling.
          </p>

          <Link
            href="/bonding"
            className="inline-flex items-center gap-1.5 text-[12.5px] font-[510] text-[#d0d6e0] transition-colors hover:text-[#f7f8f8]"
          >
            How bonding works
            <ArrowRight className="size-3" />
          </Link>
        </div>
      </div>

      {/* fork footer */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.01)] px-6 py-4 text-[12.5px] sm:px-8">
        <span className="text-[#62666d]">Read it your way</span>
        <Link
          href="/succession#builders"
          className="inline-flex items-center gap-1.5 font-[510] text-[#8a8f98] transition-colors hover:text-[#f7f8f8]"
        >
          For builders
          <ArrowRight className="size-3" />
        </Link>
        <Link
          href="/succession#operators"
          className="inline-flex items-center gap-1.5 font-[510] text-[#8a8f98] transition-colors hover:text-[#f7f8f8]"
        >
          For sureties &amp; operators
          <ArrowRight className="size-3" />
        </Link>
      </div>
    </section>
  );
}
