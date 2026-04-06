import Link from 'next/link';
import { SOLANA_FACILITATORS } from '@/config/facilitators';

export function FacilitatorList() {
  const facilitators = Object.entries(SOLANA_FACILITATORS);

  return (
    <div className="rounded-lg border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
      <div className="border-b border-[rgb(255_255_255/0.05)] px-4 py-3 flex items-center justify-between">
        <h2 className="text-[13px] font-[510] text-[#62666d] tracking-[-0.13px]">
          Tracked x402 Facilitators
        </h2>
        <Link
          href="/explore"
          className="text-[12px] font-[510] text-[#5e6ad2] hover:text-[#828fff] transition-colors"
        >
          Explore all
        </Link>
      </div>
      <div className="p-4">
        <p className="text-[14px] text-[#8a8f98] mb-4">
          Karma indexes USDC payments through these x402 facilitator addresses.
          Click a facilitator to explore its transactions.
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {facilitators.map(([name, addresses]) => (
            <Link
              key={name}
              href={`/explore?f=${addresses[0]}`}
              className="flex items-center gap-2 rounded-md bg-[rgb(255_255_255/0.03)] px-3 py-2 border border-[rgb(255_255_255/0.05)] hover:bg-[rgb(255_255_255/0.05)] hover:border-[rgb(255_255_255/0.08)] transition-colors"
            >
              <div className="size-1.5 rounded-full bg-[#5e6ad2]" />
              <span className="text-[13px] font-[510] capitalize text-[#d0d6e0]">
                {name}
              </span>
              <span className="text-[11px] tabular-nums text-[#62666d]">
                {addresses.length}
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
