'use client';

import { useEffect, useRef, useState } from 'react';
import { Code2 } from 'lucide-react';
import Link from 'next/link';
import { CodeBlock } from '@/components/karma/code-block';
import type { Chain } from '@/db/schema';

// Absolute origin for copy-paste snippets so they work outside agentkarma.io
// (READMEs, third-party sites). NEXT_PUBLIC_* is inlined at build, so this is
// stable across server render + client hydration (no mismatch).
const ORIGIN = process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io';

/**
 * Inline "Embed badge" control for an agent profile. Opens a hand-rolled popover
 * (same idiom as the explore SortMenu — no extra radix dep) with a live preview
 * of this agent's trust badge, a copy-paste markdown snippet, and a link to the
 * full widget docs. The badge URL pins `?chain=` so EVM addresses registered on
 * both Celo and Arc resolve to the right row.
 */
export function BadgeButton({ wallet, chain }: { wallet: string; chain: Chain }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const badgePath = `/api/badge/${wallet}?chain=${chain}`;
  const markdown = `[![AgentKarma](${ORIGIN}${badgePath})](${ORIGIN}/agent/${wallet})`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="inline-flex items-center gap-1 text-[12px] text-[#8a8f98] hover:text-[#f7f8f8] transition-colors"
      >
        <Code2 className="size-3" />
        Embed badge
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Embed this badge"
          className="absolute left-0 top-[calc(100%+6px)] z-30 w-[340px] max-w-[calc(100vw-2rem)] rounded-lg border border-[rgb(255_255_255/0.08)] bg-[#0d0e11] p-4 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.7)]"
        >
          <p className="text-[12px] font-[590] text-[#f7f8f8]">Embed this badge</p>
          <p className="mt-0.5 text-[11px] text-[#62666d]">
            Live trust badge for this agent. Updates automatically.
          </p>

          <div className="mt-3 flex justify-center rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(0_0_0/0.25)] p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={badgePath} alt="AgentKarma trust badge" width={240} height={76} />
          </div>

          <div className="mt-3">
            <CodeBlock lang="markdown">{markdown}</CodeBlock>
          </div>

          <Link
            href="/widget"
            className="mt-3 inline-block text-[11px] font-[510] text-[#8a8f98] hover:text-[#f7f8f8] transition-colors"
          >
            HTML, SVG &amp; JSON formats → /widget
          </Link>
        </div>
      )}
    </div>
  );
}
