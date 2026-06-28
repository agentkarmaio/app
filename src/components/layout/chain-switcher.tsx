'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { chainOptions, CHAIN_META } from '@/lib/chain-meta';
import { useChainSelection } from '@/components/layout/chain-selection';

/**
 * Header chain switcher. On browse/landing pages (`navigate` true) each option
 * links to that chain's context page. On an agent detail page (`navigate` false)
 * it switches the active-chain context in place — no navigation — so the user
 * isn't pushed off the agent they're viewing (the Connect button follows the
 * selection instead). State comes from ChainSelectionProvider.
 */
export function ChainSwitcher() {
  const { active, navigate, select } = useChainSelection();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Switch chain"
        className="inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-[510] text-[#8a8f98] transition-colors hover:bg-[rgb(255_255_255/0.06)] hover:text-[#f7f8f8]"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- tiny static brand mark; Image optimizer needs dangerouslyAllowSVG for SVGs */}
        <img aria-hidden alt="" src={CHAIN_META[active].logo} className="size-3.5 shrink-0 object-contain" />
        <span className="text-[#f7f8f8]">{CHAIN_META[active].label}</span>
        <ChevronDown className="size-3 opacity-70" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+8px)] z-50 w-[140px] rounded-2xl border border-[rgb(255_255_255/0.06)] bg-[#0f1011]/85 p-1 shadow-[0_8px_24px_-12px_rgb(0_0_0/0.6),0_1px_0_0_rgb(255_255_255/0.04)_inset] backdrop-blur-xl backdrop-saturate-150"
        >
          {chainOptions().map((c) => {
            const m = CHAIN_META[c];
            const isActive = c === active;
            const className = isActive
              ? 'flex w-full items-center gap-2 rounded-lg bg-[rgb(255_255_255/0.06)] px-2.5 py-1.5 text-left text-[13px] font-[510] text-[#f7f8f8]'
              : 'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] font-[510] text-[#8a8f98] transition-colors hover:bg-[rgb(255_255_255/0.04)] hover:text-[#f7f8f8]';
            const inner = (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element -- tiny static brand mark; Image optimizer needs dangerouslyAllowSVG for SVGs */}
                <img aria-hidden alt="" src={m.logo} className="size-4 shrink-0 object-contain" />
                {m.label}
              </>
            );
            // Agent pages switch context in place (no navigation); browse pages
            // link to the chain's context page as before.
            return navigate ? (
              <Link key={c} href={m.href} role="menuitem" onClick={() => setOpen(false)} className={className}>
                {inner}
              </Link>
            ) : (
              <button
                key={c}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                onClick={() => { select(c); setOpen(false); }}
                className={className}
              >
                {inner}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
