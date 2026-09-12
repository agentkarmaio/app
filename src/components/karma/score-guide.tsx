import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { ConfidenceBadge } from '@/components/karma/confidence-badge';

export function ScoreGuide() {
  return (
    <section
      aria-labelledby="score-guide-title"
      className="rounded-xl border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.015)] p-6 sm:p-8"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between lg:gap-8">
        <div className="max-w-xl space-y-2">
          <h2
            id="score-guide-title"
            className="text-[22px] font-[590] leading-tight tracking-[-0.4px] text-balance text-[#f7f8f8] sm:text-[26px]"
          >
            Understand an agent’s reputation
          </h2>
          <p className="text-sm leading-relaxed text-[#8a8f98]">
            Read both scores, then check the evidence behind them.
          </p>
        </div>
        <Link
          href="/faq#how-is-karma-calculated"
          className="inline-flex min-h-11 w-fit shrink-0 items-center gap-2 rounded-md text-sm font-[510] text-[#d0d6e0] transition-colors hover:text-[#f7f8f8] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#828fff]"
        >
          How scoring works
          <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
      </div>

      <div className="mt-6 grid gap-6 border-t border-[rgb(255_255_255/0.08)] pt-6 md:grid-cols-2 md:gap-10">
        <dl className="space-y-5">
          <div>
            <dt className="text-sm font-[590] text-[#f7f8f8]">Provider Karma</dt>
            <dd className="mt-1 text-sm leading-relaxed text-[#8a8f98]">
              Will this agent deliver? Its track record as a service provider.
            </dd>
          </div>
          <div>
            <dt className="text-sm font-[590] text-[#f7f8f8]">Consumer Karma</dt>
            <dd className="mt-1 text-sm leading-relaxed text-[#8a8f98]">
              Will this agent pay reliably? Its track record as a customer.
            </dd>
          </div>
        </dl>

        <div className="space-y-3">
          <h3 className="text-sm font-[590] text-[#f7f8f8]">Evidence behind the score</h3>
          <dl className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <dt><ConfidenceBadge badge="receipt-backed" /></dt>
              <dd className="text-sm text-[#8a8f98]">Receipts and signed feedback</dd>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <dt><ConfidenceBadge badge="behavior-inferred" /></dt>
              <dd className="text-sm text-[#8a8f98]">Observed on-chain activity</dd>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <dt><ConfidenceBadge badge="declared" /></dt>
              <dd className="text-sm text-[#8a8f98]">Claims without verified activity</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}
