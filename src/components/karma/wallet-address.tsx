'use client';

import { cn } from '@/lib/utils';
import { Copy, Check } from 'lucide-react';
import { useState, useCallback } from 'react';

export function WalletAddress({
  address,
  truncate = true,
  copyable = true,
  className,
}: {
  address: string;
  truncate?: boolean;
  copyable?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const display = truncate
    ? `${address.slice(0, 4)}...${address.slice(-4)}`
    : address;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [address]);

  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center gap-1 font-mono text-sm bg-transparent border-none p-0',
        copyable && 'cursor-pointer hover:text-foreground/80',
        !copyable && 'cursor-default',
        className,
      )}
      onClick={copyable ? handleCopy : undefined}
      title={address}
    >
      {display}
      {copyable && (
        copied
          ? <Check className="size-3 text-emerald-500" />
          : <Copy className="size-3 text-muted-foreground" />
      )}
    </button>
  );
}
