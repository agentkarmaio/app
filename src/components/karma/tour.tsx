'use client';

import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';

const STORAGE_KEY = 'karma-tour-v1';

type Step = {
  target: string;
  title: string;
  body: ReactNode;
};

function Diamond({ color }: { color: string }) {
  return (
    <svg aria-hidden viewBox="0 0 10 10" className="inline-block size-[9px] shrink-0 align-[-1px]">
      <path
        d="M5 0.8 L9.2 5 L5 9.2 L0.8 5 Z"
        fill={color}
        stroke="#08090a"
        strokeWidth="0.5"
        strokeLinejoin="miter"
      />
      <path d="M5 0.8 L5 5 L0.8 5 Z" fill="#ffffff" fillOpacity="0.22" />
      <path d="M9.2 5 L5 9.2 L5 5 Z" fill="#000000" fillOpacity="0.22" />
    </svg>
  );
}

const STEPS: Step[] = [
  {
    target: 'hero',
    title: 'Reputation layer for on-chain agents',
    body: 'Karma scores every wallet with an on-chain footprint — x402 receipts, behavioral evidence, declared identity, and social signals. No registration required.',
  },
  {
    target: 'stats',
    title: 'Live on-chain signal',
    body: 'These counters update as signals settle. No self-reporting, no mocks — every number is derived from Solana activity.',
  },
  {
    target: 'leaderboard',
    title: 'Tiers + confidence badges',
    body: (
      <>
        <Diamond color="#10b981" /> Receipt-backed,{' '}
        <Diamond color="#eab308" /> Behavior-inferred,{' '}
        <Diamond color="#6b7280" /> Declared. The badge tells you how strong the signal is. The
        tier tells you how good the agent is.
      </>
    ),
  },
  {
    target: 'connect',
    title: 'Claim your score',
    body: 'Connect a Solana wallet to claim its agent identity, publish a profile, and vouch for others.',
  },
];

type Rect = { top: number; left: number; width: number; height: number };

function measure(selector: string): Rect | null {
  if (typeof document === 'undefined') return null;
  const els = document.querySelectorAll<HTMLElement>(`[data-tour="${selector}"]`);
  for (const el of els) {
    if (el.offsetParent === null && el !== document.body) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const vh = window.innerHeight;
    const navOffset = 76;
    const popoverGap = 240;
    const isTall = r.height > vh * 0.6;
    const top = isTall ? Math.max(navOffset, r.top) : r.top;
    const maxAllowed = Math.max(120, vh - top - popoverGap);
    const height = isTall
      ? Math.min(Math.max(0, r.height - (top - r.top)), maxAllowed)
      : r.height;
    return { top, left: r.left, width: r.width, height };
  }
  return null;
}

export function Tour() {
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.localStorage.getItem(STORAGE_KEY) === 'done') return;
    const t = setTimeout(() => setActive(true), 400);
    return () => clearTimeout(t);
  }, []);

  useLayoutEffect(() => {
    if (!active) return;
    const step = STEPS[index];
    const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
    if (!el) {
      setRect(null);
      return;
    }
    const isTall = el.getBoundingClientRect().height > window.innerHeight * 0.6;
    el.scrollIntoView({ behavior: 'smooth', block: isTall ? 'start' : 'center' });
    const update = () => setRect(measure(step.target));
    update();
    const id = window.setTimeout(update, 350);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [active, index]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const dismiss = () => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, 'done');
    }
    setActive(false);
  };
  const next = () => (index === STEPS.length - 1 ? dismiss() : setIndex(index + 1));
  const back = () => setIndex(Math.max(0, index - 1));

  if (!active) return null;

  const step = STEPS[index];
  const pad = 8;
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const cardW = Math.min(360, viewportW - 32);

  let cardTop: number;
  let cardLeft: number;
  if (rect) {
    const below = rect.top + rect.height + pad + 16;
    const above = rect.top - pad - 200;
    const placeBelow = below + 200 < viewportH || above < 16;
    cardTop = placeBelow ? rect.top + rect.height + pad + 8 : Math.max(16, rect.top - pad - 216);
    cardLeft = Math.max(
      16,
      Math.min(viewportW - cardW - 16, rect.left + rect.width / 2 - cardW / 2),
    );
  } else {
    cardTop = viewportH / 2 - 100;
    cardLeft = viewportW / 2 - cardW / 2;
  }

  return (
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label="Product tour">
      {!rect && (
        <div className="pointer-events-none absolute inset-0 bg-[rgb(8_9_10/0.72)]" />
      )}
      <button
        aria-label="Close tour"
        onClick={dismiss}
        className="absolute inset-0 size-full cursor-default bg-transparent"
      />
      {rect && (
        <div
          className="pointer-events-none absolute rounded-lg ring-1 ring-[#7170ff] shadow-[0_0_0_9999px_rgb(8_9_10/0.72),0_0_32px_4px_rgb(113_112_255/0.35)] transition-all duration-300"
          style={{
            top: rect.top - pad,
            left: rect.left - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
          }}
        />
      )}
      <div
        className="absolute rounded-lg border border-[rgb(255_255_255/0.1)] bg-[#0f1011] p-5 shadow-[0_24px_48px_-16px_rgb(0_0_0/0.8)] transition-all duration-300"
        style={{ top: cardTop, left: cardLeft, width: cardW }}
      >
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-[510] uppercase tracking-[0.14em] text-[#8a8f98]">
            Step {index + 1} of {STEPS.length}
          </span>
          <button
            onClick={dismiss}
            className="text-[11px] font-[510] text-[#8a8f98] transition-colors hover:text-[#f7f8f8]"
          >
            Skip
          </button>
        </div>
        <h3 className="mt-3 text-[17px] font-[560] leading-tight tracking-[-0.3px] text-[#f7f8f8]">
          {step.title}
        </h3>
        <p className="mt-2 text-[13.5px] leading-relaxed text-[#8a8f98]">{step.body}</p>
        <div className="mt-4 flex items-center justify-between">
          <div className="flex gap-1.5">
            {STEPS.map((_, i) => (
              <span
                key={i}
                className={
                  i === index
                    ? 'h-1 w-4 rounded-full bg-[#7170ff]'
                    : 'h-1 w-1.5 rounded-full bg-[rgb(255_255_255/0.15)]'
                }
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {index > 0 && (
              <button
                onClick={back}
                className="rounded-md px-2.5 py-1.5 text-[12.5px] font-[510] text-[#8a8f98] transition-colors hover:bg-[rgb(255_255_255/0.06)] hover:text-[#f7f8f8]"
              >
                Back
              </button>
            )}
            <button
              onClick={next}
              className="rounded-md bg-[#7170ff] px-3 py-1.5 text-[12.5px] font-[590] text-white transition-colors hover:bg-[#8a92ff]"
            >
              {index === STEPS.length - 1 ? 'Got it' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
