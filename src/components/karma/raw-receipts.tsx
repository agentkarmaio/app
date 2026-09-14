'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Collapsed wrapper for the per-receipt table. The rollups above answer "who
 * does this agent trade with"; the raw rows answer "what happened at 14:32",
 * which is a block-explorer question — kept, because it is the audit trail, but
 * not given the top of the card.
 *
 * The table mounts only once opened, so the closed state costs nothing: the
 * child's IntersectionObserver pagination never fires against
 * /api/agent/[wallet]/history until a reader asks for it.
 */
export function RawReceipts({ count, children }: { count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  if (count === 0) return null;

  return (
    <div className="border-t border-[rgb(255_255_255/0.05)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-4 py-3 text-left text-[12px] font-[510] text-[#62666d] transition-colors hover:text-[#8a8f98]"
      >
        <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
        Raw receipts
        <span className="tabular-nums text-[#4f5258]">({count.toLocaleString()})</span>
      </button>
      {open && children}
    </div>
  );
}
