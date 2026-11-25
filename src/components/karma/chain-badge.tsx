import type { Chain } from '@/db/schema';

/**
 * Per-row chain indicator for tables that mix wallets across chains
 * (leaderboard preview + /explore Agents tab). Linear-flavored: tiny inline
 * SVG mark on a faintly tinted, rounded chip. Two-three letter monogram is
 * used in title-only — the visual is the mark + the muted brand tint.
 *
 * Notes:
 *   - Inline SVG keeps the row scannable and avoids extra <img> requests; the
 *     pattern mirrors LegendDiamond / TierBadge.
 *   - `arc` is currently testnet-only. We render the same tint as mainnet would
 *     get but the title carries the "(testnet)" suffix; visible network
 *     distinction is deferred until mainnet ships.
 */

interface ChainMark {
  /** Short brand label used in title attr. */
  label: string;
  /** Whether the chain row is currently a testnet ingest. */
  testnet?: boolean;
  /** Brand tint approximations — kept dim so rows stay scannable. */
  tint: { bg: string; border: string; fg: string };
  /** Inline SVG mark. 12px box by default; pass a className to resize. */
  Mark: (props: { className?: string }) => React.ReactElement;
}

// Solana purple→cyan gradient → use the purple primary as a single fill.
function SolanaMark({ className = 'size-3 shrink-0' }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden className={className}>
      <path
        d="M2.4 8.5h6.3a.4.4 0 0 1 .29.68l-1 1a.6.6 0 0 1-.43.18H1.27a.4.4 0 0 1-.29-.68l1-1a.6.6 0 0 1 .43-.18Zm0-3.25h6.3a.4.4 0 0 1 .29.68l-1 1a.6.6 0 0 1-.43.17H1.27a.4.4 0 0 1-.29-.68l1-1a.6.6 0 0 1 .43-.17Zm6.73-2.07-1 1a.6.6 0 0 1-.43.17H1.27a.4.4 0 0 1-.29-.68l1-1a.6.6 0 0 1 .43-.18H8.7a.4.4 0 0 1 .43.69Z"
        fill="#9c7cf9"
      />
    </svg>
  );
}

// Celo: the yellow square+circle mark.
function CeloMark({ className = 'size-3 shrink-0' }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden className={className}>
      <path
        fill="#fcff52"
        d="M1 1h10v3.57h-1.73a3.57 3.57 0 1 0 0 2.86H11V11H1z"
      />
    </svg>
  );
}

// Stellar: simplified swept-arc mark.
function StellarMark({ className = 'size-3 shrink-0' }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden className={className}>
      <path
        fill="#cfe9ff"
        d="M6 1.2a4.8 4.8 0 0 0-4.6 6.13L11 2.6V1.5L4.4 4.93A3.6 3.6 0 0 1 9.46 2.7l1.18-.6A4.8 4.8 0 0 0 6 1.2Zm4.6 3.47L1 9.4v1.1l6.6-3.43A3.6 3.6 0 0 1 2.54 9.3l-1.18.6A4.8 4.8 0 0 0 10.6 4.67Z"
      />
    </svg>
  );
}

// Arc: arch silhouette in a Circle-ish slate-blue.
function ArcMark({ className = 'size-3 shrink-0' }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden className={className}>
      <path
        fill="#7da6ff"
        d="M.2 11.3c.13-3.46.86-6.7 2.08-9.16C3.92.83 4.99.2 6 .2c1.01 0 2.08.63 3.72 1.94 1.22 2.46 1.95 5.7 2.08 9.16h-2.04c-.04-1.62-.21-3.16-.5-4.5C8.84 4 7.4 2.45 6 2.45S3.16 4 2.74 6.8a23 23 0 0 0-.5 4.5H.2Z"
      />
    </svg>
  );
}

// Robinhood Chain: the official feather symbol, lifted from the chain's
// brand-asset kit (Robinhood_Chain_Logo_White.svg), in the brand lime.
function RobinhoodChainMark({ className = 'size-3 shrink-0' }: { className?: string }) {
  return (
    <svg viewBox="-22 0 207 207" aria-hidden className={className}>
      <path
        fill="#ccff00"
        d="M102.68,48.62c-23.4,26.03-60.7,69.5-94.97,157.27-.41.69-1.1,1.11-1.93,1.11H1.24c-.96,0-1.51-.55-1.1-1.66,4.54-16.89,10.74-35.58,20.51-63.13v-38.21c0-7.34,1.1-12.46,5.51-18l30-37.38c.96-1.38,2.34-1.94,3.85-1.94h41.84c1.38,0,1.79.83.83,1.94ZM152.23,5.57c7.3,7.75,8.26,26.44,6.61,38.62-1.24,8.31-2.61,10.11-7.16,16.06l-27.94,36.69c-.83,1.25-1.93.83-1.93-.55v-52.61c0-4.29-2.48-6.78-6.74-6.78h-46.38c-1.38,0-1.79-.97-.83-1.94,7.85-8.31,16.1-16.75,28.49-27.41,2.75-2.49,4.13-2.77,6.74-4.01,13.49-5.26,42.67-4.98,49.14,1.94h0ZM112.04,58.03v52.88c0,.69-.14,1.66-.55,2.49l-19.13,31.7c-2.34,3.88-5.09,6.09-9.91,7.34l-42.94,13.29c-1.24.41-1.93-.42-1.38-1.52,20.78-40.84,43.22-74.76,71.98-107.01.96-1.11,1.93-.55,1.93.83h0Z"
      />
    </svg>
  );
}

const MARKS: Record<Chain, ChainMark> = {
  solana: {
    label: 'Solana',
    tint: {
      bg: 'rgb(156_124_249/0.10)',
      border: 'rgb(156_124_249/0.22)',
      fg: '#c4b1fd',
    },
    Mark: SolanaMark,
  },
  celo: {
    label: 'Celo',
    tint: {
      bg: 'rgb(252_255_82/0.10)',
      border: 'rgb(252_255_82/0.22)',
      fg: '#e7e98a',
    },
    Mark: CeloMark,
  },
  stellar: {
    label: 'Stellar',
    tint: {
      bg: 'rgb(207_233_255/0.08)',
      border: 'rgb(207_233_255/0.18)',
      fg: '#cfe9ff',
    },
    Mark: StellarMark,
  },
  arc: {
    label: 'Arc',
    testnet: true,
    tint: {
      bg: 'rgb(125_166_255/0.10)',
      border: 'rgb(125_166_255/0.22)',
      fg: '#a8bfff',
    },
    Mark: ArcMark,
  },
  'arc-mainnet': {
    label: 'Arc',
    tint: { bg: 'rgb(125_166_255/0.10)', border: 'rgb(125_166_255/0.22)', fg: '#a8bfff' },
    Mark: ArcMark,
  },
  // API-only; present for type completeness, never rendered on public pages.
  'stellar-testnet': {
    label: 'Stellar',
    testnet: true,
    tint: { bg: 'rgb(207_233_255/0.08)', border: 'rgb(207_233_255/0.18)', fg: '#cfe9ff' },
    Mark: StellarMark,
  },
  robinhood: {
    label: 'Robinhood',
    tint: { bg: 'rgb(204_255_0/0.08)', border: 'rgb(204_255_0/0.22)', fg: '#e6ff80' },
    Mark: RobinhoodChainMark,
  },
};

/**
 * Bare chain glyph — the same brand-filled mark as <ChainBadge>, but without the
 * chip/border, for dense visual contexts (the trust constellation legend + hover
 * card) where a full chip would be too heavy. Defaults to 12px; pass a Tailwind
 * size class to match surrounding text.
 */
export function ChainMark({
  chain,
  className,
}: {
  chain: Chain;
  className?: string;
}) {
  const meta = MARKS[chain];
  const Mark = meta.Mark;
  const title = meta.testnet ? `${meta.label} (testnet)` : meta.label;
  return (
    <span role="img" aria-label={title} title={title} className="inline-flex shrink-0">
      <Mark className={`${className ?? 'size-3'} shrink-0`} />
    </span>
  );
}

export function ChainBadge({
  chain,
  variant = 'mark',
}: {
  chain: Chain;
  /**
   * `mark`  — tiny icon-only chip (default; intended for inline use next to
   *           the agent name in dense tables).
   * `label` — same chip with the chain name appended for legend/header use.
   */
  variant?: 'mark' | 'label';
}) {
  const meta = MARKS[chain];
  const title = meta.testnet ? `${meta.label} (testnet)` : meta.label;
  const Mark = meta.Mark;

  if (variant === 'label') {
    return (
      <span
        title={title}
        className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-[510] tracking-[-0.04px] tabular-nums"
        style={{
          background: meta.tint.bg,
          borderColor: meta.tint.border,
          color: meta.tint.fg,
        }}
      >
        <Mark />
        <span className="leading-none">{meta.label}</span>
      </span>
    );
  }

  return (
    <span
      title={title}
      aria-label={title}
      role="img"
      className="inline-flex shrink-0 items-center justify-center rounded-[5px] border size-[18px]"
      style={{
        background: meta.tint.bg,
        borderColor: meta.tint.border,
      }}
    >
      <Mark />
    </span>
  );
}
