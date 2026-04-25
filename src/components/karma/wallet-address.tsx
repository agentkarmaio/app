'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils';
import { Copy, Check } from 'lucide-react';
import { useState, useCallback } from 'react';

export function WalletAddress({
  address,
  truncate = true,
  copyable = true,
  href,
  className,
}: {
  address: string;
  truncate?: boolean;
  copyable?: boolean;
  /** If provided, renders the address text as a link; copy icon stays separate. */
  href?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const display = truncate
    ? `${address.slice(0, 4)}...${address.slice(-4)}`
    : address;

  const handleCopy = useCallback((e: React.MouseEvent) => {
    // Copy is isolated from text/row clicks: we explicitly stop bubbling so
    // an ancestor <a> or clickable row doesn't navigate when the user only
    // wanted to copy the address.
    e.stopPropagation();
    e.preventDefault();
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [address]);

  return (
    <span className={cn('inline-flex items-center gap-1 font-mono text-sm', className)}>
      {href ? (
        <Link
          href={href}
          onClick={(e) => e.stopPropagation()}
          className="hover:text-foreground/80 transition-colors"
          title={address}
        >
          {display}
        </Link>
      ) : (
        <span title={address}>{display}</span>
      )}
      {copyable && (
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy address"
          title="Copy address"
          className="inline-flex items-center text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          {copied
            ? <Check className="size-3 text-emerald-500" />
            : <Copy className="size-3" />
          }
        </button>
      )}
    </span>
  );
}
