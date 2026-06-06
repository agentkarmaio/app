'use client';

import type { Chain } from '@/db/schema';
import { chainOptions, CHAIN_META } from '@/lib/chain-meta';

export type ChainFilter = 'All' | Chain;

/**
 * Chain filter for the leaderboard. 'All' = no chain filter (every chain).
 * Mirrors FilterGroup (leaderboard-with-load-more.tsx) — plain pills, no Radix.
 */
export function ChainFilterPill({
  value,
  onChange,
}: {
  value: ChainFilter;
  onChange: (v: ChainFilter) => void;
}) {
  const options: ChainFilter[] = ['All', ...chainOptions()];
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] font-[510] uppercase tracking-[0.08em] text-[#62666d]">
        Chain
      </span>
      <div className="flex items-center">
        {options.map((opt) => {
          const active = opt === value;
          const label = opt === 'All' ? 'All' : CHAIN_META[opt].label;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              className={
                active
                  ? 'rounded-[5px] bg-[rgb(255_255_255/0.06)] px-1.5 py-0.5 text-[11px] font-[510] text-[#f7f8f8]'
                  : 'rounded-[5px] px-1.5 py-0.5 text-[11px] font-[510] text-[#8a8f98] transition-colors hover:text-[#f7f8f8]'
              }
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
