'use client';

import { useState } from 'react';
import Link from 'next/link';
import { TierBadge } from '@/components/karma/tier-badge';
import { formatUsdcAmount } from '@/lib/format';
import { formatRelativePast } from '@/lib/succession-format';
import type { TrustTier } from '@/db/schema';

const INITIAL_COUNT = 8;

export interface RollupRow {
  address: string;
  href: string;
  displayName: string | null;
  trustTier: TrustTier | null;
  count: number;
  total: number;
  lastSeen: string;
  /** This row's share of the direction's credited value, 0–1. */
  share: number;
}

function shortAddr(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * One counterparty relationship. The row's share of the direction's credited
 * value is drawn as a bar BEHIND the content rather than as another number:
 * concentration is the thing a reader should see at a glance, and eight
 * percentages in a column are read one at a time.
 */
function Row({ row }: { row: RollupRow }) {
  return (
    <Link
      href={row.href}
      className="relative flex items-center gap-3 overflow-hidden rounded-md px-3 py-2 transition-colors hover:bg-[rgb(255_255_255/0.04)]"
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 bg-[rgb(94_106_210/0.10)]"
        style={{ width: `${Math.max(1.5, row.share * 100)}%` }}
      />
      <span className="relative flex min-w-0 flex-1 items-center gap-2">
        <span
          className={
            row.displayName
              ? 'truncate text-[13px] font-[510] text-[#d0d6e0]'
              : 'truncate font-mono text-[12px] text-[#8a8f98]'
          }
          title={row.address}
        >
          {row.displayName ?? shortAddr(row.address)}
        </span>
        {row.trustTier && row.trustTier !== 'Unrated' && (
          <TierBadge tier={row.trustTier} size="sm" className="shrink-0" />
        )}
      </span>
      <span className="relative shrink-0 text-right text-[12px] tabular-nums text-[#62666d]">
        {row.count.toLocaleString()}
        <span className="hidden sm:inline">{row.count === 1 ? ' payment' : ' payments'}</span>
      </span>
      <span
        className="relative w-20 shrink-0 text-right text-[13px] font-[510] tabular-nums text-[#d0d6e0]"
        title={`${row.total.toFixed(6)} USDC credited`}
      >
        {formatUsdcAmount(row.total, true)}
      </span>
      <span
        className="relative hidden w-16 shrink-0 text-right text-[11px] tabular-nums text-[#4f5258] sm:block"
        suppressHydrationWarning
      >
        {formatRelativePast(row.lastSeen)}
      </span>
    </Link>
  );
}

export function RollupList({
  rows,
  emptyLabel,
  totalCount,
}: {
  rows: RollupRow[];
  emptyLabel: string;
  /**
   * Relationships in the whole rollup, which can exceed `rows` when the render
   * cap bites. The expand button says which of the two it is showing — a
   * button reading "Show all 24" under a header saying "27 payers" is a lie the
   * reader has no way to catch.
   */
  totalCount: number;
}) {
  const [expanded, setExpanded] = useState(false);

  if (rows.length === 0) {
    return <p className="px-3 py-4 text-[13px] text-[#62666d]">{emptyLabel}</p>;
  }

  const visible = expanded ? rows : rows.slice(0, INITIAL_COUNT);
  const hidden = rows.length - INITIAL_COUNT;

  return (
    <div className="space-y-0.5">
      {visible.map((row) => (
        <Row key={row.address} row={row} />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="w-full rounded-md px-3 py-2 text-left text-[12px] font-[510] text-[#5e6ad2] transition-colors hover:bg-[rgb(255_255_255/0.03)] hover:text-[#828fff]"
        >
          {expanded
            ? 'Show less'
            : rows.length < totalCount
              ? `Show top ${rows.length.toLocaleString()} of ${totalCount.toLocaleString()}`
              : `Show all ${rows.length.toLocaleString()}`}
        </button>
      )}
    </div>
  );
}
